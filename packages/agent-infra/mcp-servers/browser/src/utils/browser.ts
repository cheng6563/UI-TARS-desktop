import path from 'node:path';
import { Browser, Page } from 'puppeteer-core';
import { LocalBrowser, RemoteBrowser } from '@agent-infra/browser';
import { PuppeteerBlocker } from '@ghostery/adblocker-puppeteer';
import { getBuildDomTreeScript } from '@agent-infra/browser-use';
import { parseProxyUrl, delayReject } from '../utils/utils.js';
import fetch from 'cross-fetch';

import { store } from '../store.js';
import { ensureDirExists } from './file.js';
import { consoleLogs, networkRequests, NetworkRequestEntry } from '../resources/index.js';

// Track whether listeners are already registered per page
const pageListenerKey = '__mcp_browser_listeners_attached__';

export function attachPageListeners(page: Page) {
  // @ts-expect-error custom flag on page instance
  if (page[pageListenerKey]) return;
  // @ts-expect-error
  page[pageListenerKey] = true;

  // Console log listener
  page.on('console', (msg) => {
    const location = msg.location();
    const locStr = location.url ? ` (${location.url}:${location.lineNumber})` : '';
    consoleLogs.push(`[${msg.type()}] ${msg.text()}${locStr}`);
  });

  // Network request/response listener
  page.on('request', (request) => {
    const entry: NetworkRequestEntry = {
      url: request.url(),
      method: request.method(),
      status: 0,
      statusText: '',
      requestHeaders: request.headers(),
      responseHeaders: {},
      responseBody: '',
      timestamp: new Date().toISOString(),
      resourceType: request.resourceType(),
    };
    // @ts-expect-error store entry on request for response matching
    request[pageListenerKey] = entry;
  });

  page.on('response', async (response) => {
    // @ts-expect-error
    const entry = response.request()[pageListenerKey] as NetworkRequestEntry | undefined;
    if (!entry) return;

    entry.status = response.status();
    entry.statusText = response.statusText();
    entry.responseHeaders = response.headers();

    try {
      const body = await response.text();
      // Cap response body to 500KB to avoid memory issues
      entry.responseBody = body.length > 500 * 1024 ? body.slice(0, 500 * 1024) + '\n...(truncated)' : body;
    } catch {
      entry.responseBody = '(response body unavailable)';
    }

    networkRequests.push(entry);
    // Keep at most 500 entries
    if (networkRequests.length > 500) {
      networkRequests.splice(0, networkRequests.length - 500);
    }
  });
}

export const getCurrentPage = async (browser: Browser) => {
  const { logger } = store;

  const pages = await browser?.pages();
  // if no pages, create a new page
  if (!pages?.length)
    return { activePage: await browser?.newPage(), activePageId: 0 };

  let activePage = null;
  let activePageId = 0;
  for (let idx = pages.length - 1; idx >= 0; idx--) {
    const page = pages[idx];

    const [isVisible, isHealthy] = await Promise.all([
      Promise.race([
        page.evaluate(
          /* istanbul ignore next */ () =>
            document.visibilityState === 'visible',
        ),
        delayReject(5000),
      ]).catch((_) => false),
      Promise.race([
        page
          .evaluate(/* istanbul ignore next */ () => 1 + 1)
          .then((r) => r === 2),
        delayReject(5000),
      ]).catch((_) => false),
    ]);

    logger.info(
      `[getCurrentPage]: page: ${page.url()}, pageId: ${idx}, isVisible: ${isVisible}, isHealthy: ${isHealthy}`,
    );

    // priority 1: use visible page
    if (isVisible) {
      activePage = page;
      activePageId = idx;
      break;
      // priority 2: use healthy page
    } else if (!isVisible && isHealthy) {
      activePage = page;
      activePageId = idx;
      continue;
    } else {
      try {
        // last chance to check if the page is still responsive
        await Promise.race([
          page.evaluate(/* istanbul ignore next */ () => document.title),
          delayReject(2000),
        ]);
        // if the page is still responsive, keep it
        activePage = page;
        activePageId = idx;
        logger.debug(`Page ${idx} is still responsive, keeping it`);
        break;
      } catch (finalError) {
        logger.error(
          `page ${page.url()} is completely unresponsive, will close it`,
        );
        try {
          await page.close();
        } catch (closeError) {
          logger.warn(`Failed to close page ${idx}:`, closeError);
        }
      }
    }
  }

  if (!activePage) {
    activePage = pages?.[0];
    activePageId = 0;
  }

  return {
    activePage,
    activePageId,
  };
};

export const getTabList = async (browser: Browser, activePageId: number) => {
  const pages = await browser?.pages();
  return await Promise.all(
    pages?.map(async (page, idx) => ({
      index: idx,
      active: idx === activePageId,
      title: await page.title(),
      url: await page.url(),
    })) || [],
  );
};

export async function ensureBrowser() {
  const { logger } = store;

  if (store.globalBrowser) {
    try {
      logger.info('starting to check if browser session is closed');
      const pages = await store.globalBrowser?.pages();
      if (!pages?.length) {
        throw new Error('browser session is closed');
      }
      logger.info(`detected browser session is still open: ${pages.length}`);
    } catch (error) {
      logger.warn(
        'detected browser session closed, will reinitialize browser',
        error,
      );
      store.globalBrowser = null;
      store.globalPage = null;
    }
  }

  // priority 2: use external browser from config if available
  if (!store.globalBrowser && store.globalConfig.externalBrowser) {
    store.globalBrowser =
      await store.globalConfig.externalBrowser?.getBrowser();
    logger.info('Using external browser instance');
  }

  // priority 3: create new browser and page
  if (!store.globalBrowser) {
    const browser = store.globalConfig.remoteOptions
      ? new RemoteBrowser(store.globalConfig.remoteOptions)
      : new LocalBrowser();
    await browser.launch(store.globalConfig.launchOptions);

    store.globalBrowser = browser.getBrowser();
  }
  let currTabsIdx = 0;

  if (!store.globalPage) {
    const pages = await store.globalBrowser?.pages();
    store.globalPage = pages?.[0];
    currTabsIdx = 0;
    // Attach listeners to the initial page
    if (store.globalPage) {
      attachPageListeners(store.globalPage);
    }
  } else {
    const { activePage, activePageId } = await getCurrentPage(
      store.globalBrowser,
    );
    store.globalPage = activePage || store.globalPage;
    currTabsIdx = activePageId || currTabsIdx;
  }

  if (store.globalConfig.contextOptions?.userAgent) {
    store.globalPage.setUserAgent(store.globalConfig.contextOptions.userAgent);
  }

  // inject the script to the page
  const injectScriptContent = getBuildDomTreeScript();
  await store.globalPage.evaluateOnNewDocument(injectScriptContent);

  if (store.globalConfig.enableAdBlocker) {
    try {
      await Promise.race([
        PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch).then((blocker) =>
          blocker.enableBlockingInPage(store.globalPage as any),
        ),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Blocking In Page timeout')), 1200),
        ),
      ]);
    } catch (e) {
      logger.error('Error enabling adblocker:', e);
    }
  }

  // set proxy authentication
  if (store.globalConfig.launchOptions?.proxy) {
    const proxy = parseProxyUrl(store.globalConfig.launchOptions?.proxy || '');
    if (proxy.username || proxy.password) {
      await store.globalPage.authenticate({
        username: proxy.username,
        password: proxy.password,
      });
    }
  }

  if (!store.initialBrowserSetDownloadBehavior) {
    const client = await store.globalBrowser.target().createCDPSession();
    const { outputDir } = store.globalConfig;
    await client.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: outputDir,
      eventsEnabled: true,
    });

    client.on('Browser.downloadWillBegin', async (event) => {
      if (event.suggestedFilename && event.url && event.guid) {
        await ensureDirExists(outputDir);

        store.downloadedFiles.push({
          guid: event.guid,
          url: event.url,
          suggestedFilename: event.suggestedFilename,
          resourceUri: path.join(outputDir!, event.suggestedFilename),
          createdAt: new Date().toISOString(),
          progress: 0,
          state: 'inProgress',
        });

        logger.info(`start to download file: ${event.suggestedFilename}`);
      }
    });

    client.on('Browser.downloadProgress', (event) => {
      const idx = store.downloadedFiles.findIndex(
        (file) => file.guid === event.guid,
      );
      const downloadInfo = store.downloadedFiles[idx];
      if (downloadInfo) {
        downloadInfo.state = event.state;
        downloadInfo.progress =
          event.totalBytes > 0
            ? (event.receivedBytes / event.totalBytes) * 100
            : 0;

        logger.info(
          `下载进度 [${event.guid}]: ${downloadInfo.progress.toFixed(2)}%`,
        );
        logger.info(
          `状态: ${event.state}, 已下载: ${event.receivedBytes}/${event.totalBytes}`,
        );

        if (event.state === 'completed') {
          // @ts-ignore
          if (event.filePath) {
            // @ts-ignore
            downloadInfo.resourceUri = event.filePath;
          }
        }

        // canceled from browser
        if (event.state === 'canceled') {
          store.downloadedFiles.splice(idx, 1);
        }
      }
    });

    store.initialBrowserSetDownloadBehavior = true;

    logger.info('set download behavior success');
  }

  return {
    browser: store.globalBrowser,
    page: store.globalPage,
    currTabsIdx,
  };
}
