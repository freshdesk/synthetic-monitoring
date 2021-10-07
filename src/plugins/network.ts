/**
 * MIT License
 *
 * Copyright (c) 2020-present, Elastic NV
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

import { Request, Response } from 'playwright-chromium';
import { NetworkInfo, BrowserInfo, Driver } from '../common_types';
import { Step } from '../dsl';
import { getTimestamp } from '../helpers';

/**
 * Kibana UI expects the requestStartTime and loadEndTime to be baseline
 * in seconds as they have the logic to convert it to milliseconds before
 * using for offset calculation
 */
function epochTimeInSeconds() {
  return getTimestamp() / 1e6;
}

/**
 * Used as a key in each Network Request to identify the
 * associated request across distinct lifecycle events
 */
export const NETWORK_ENTRY_SUMBOL = Symbol.for('NetworkEntry');

type RequestWithEntry = Request & {
  NETWORK_ENTRY_SUMBOL?: symbol;
};

export class NetworkManager {
  private _browser: BrowserInfo;
  results: Array<NetworkInfo> = [];
  _currentStep: Partial<Step> = null;

  constructor(private driver: Driver) {}

  async start() {
    const { client, context } = this.driver;
    const { product } = await client.send('Browser.getVersion');
    const [name, version] = product.split('/');
    this._browser = { name, version };
    context.on('request', this._onRequest.bind(this));
    context.on('response', this._onResponse.bind(this));
    context.on('requestfinished', this._onRequestCompleted.bind(this));
    context.on('requestfailed', this._onRequestCompleted.bind(this));
  }

  private _findNetworkEntry(
    request: RequestWithEntry
  ): NetworkInfo | undefined {
    return request[NETWORK_ENTRY_SUMBOL];
  }

  private _onRequest(request: Request) {
    const url = request.url();
    /**
     * Data URI should not show up as network requests
     */
    if (url.startsWith('data:')) {
      return;
    }

    const timestamp = getTimestamp();
    const networkEntry: NetworkInfo = {
      browser: this._browser,
      step: this._currentStep,
      timestamp,
      url,
      type: request.resourceType(),
      method: request.method(),
      requestSentTime: epochTimeInSeconds(),
      request: {
        url,
        method: request.method(),
        headers: {},
      },
      response: {
        statusCode: -1,
        mimeType: 'x-unknown',
        headers: {},
        redirectURL: '',
      },
      isNavigationRequest: request.isNavigationRequest(),
      status: -1,
      loadEndTime: -1,
      responseReceivedTime: -1,
      resourceSize: 0,
      transferSize: 0,
      timings: null,
    };

    if (request.redirectedFrom()) {
      const fromEntry = this._findNetworkEntry(request.redirectedFrom());
      if (fromEntry) fromEntry.response.redirectURL = request.url();
    }
    request[NETWORK_ENTRY_SUMBOL] = networkEntry;
    this.results.push(networkEntry);
  }

  private async _onResponse(response: Response) {
    const request = response.request();
    const networkEntry = this._findNetworkEntry(request);
    if (!networkEntry) return;

    const server = await response.serverAddr();
    const responseHeaders = await response.allHeaders();
    const mimeType = responseHeaders['content-type']
      ? responseHeaders['content-type'].split(';')[0]
      : 'unknown';

    const requestHeaders = await request.allHeaders();

    networkEntry.request.headers = requestHeaders;
    networkEntry.request.referrer = requestHeaders?.referer;
    networkEntry.response = {
      url: response.url(),
      statusCode: response.status(),
      statusText: response.statusText(),
      headers: responseHeaders,
      mimeType,
      redirectURL: networkEntry.response.redirectURL,
      securityDetails: await response.securityDetails(),
      remoteIPAddress: server?.ipAddress,
      remotePort: server?.port,
    };
    networkEntry.status = response.status();
    networkEntry.responseReceivedTime = epochTimeInSeconds();
  }

  private async _onRequestCompleted(request: Request) {
    const networkEntry = this._findNetworkEntry(request);
    if (!networkEntry) return;

    networkEntry.loadEndTime = epochTimeInSeconds();

    // For aborted/failed requests sizes does not exist
    const sizes = await request.sizes().catch(() => {});
    if (sizes) {
      networkEntry.request.bytes =
        sizes.requestHeadersSize + sizes.requestBodySize;
      networkEntry.request.body = {
        bytes: sizes.requestBodySize,
      };
      networkEntry.response.bytes =
        sizes.responseHeadersSize + sizes.responseBodySize;
      networkEntry.response.body = {
        bytes: sizes.responseBodySize,
      };
      networkEntry.transferSize = sizes.responseBodySize;
    }

    const timing = request.timing();
    const { loadEndTime, requestSentTime } = networkEntry;
    networkEntry.timings = {
      blocked: -1,
      dns: -1,
      ssl: -1,
      connect: -1,
      send: -1,
      wait: -1,
      receive: -1,
      total: -1,
    };

    const firstPositive = (numbers: number[]) => {
      for (let i = 0; i < numbers.length; ++i) {
        if (numbers[i] > 0) {
          return numbers[i];
        }
      }
      return null;
    };
    const roundMilliSecs = (value: number): number => {
      return Math.floor(value * 1000) / 1000;
    };

    if (timing.startTime === 0) {
      // Convert to milliseconds before round off
      const total = roundMilliSecs((loadEndTime - requestSentTime) * 1000);
      networkEntry.timings.total = total;
      return;
    }

    const blocked =
      roundMilliSecs(
        firstPositive([
          timing.domainLookupStart,
          timing.connectStart,
          timing.requestStart,
        ])
      ) || -1;
    const dns =
      timing.domainLookupEnd !== -1
        ? roundMilliSecs(timing.domainLookupEnd - timing.domainLookupStart)
        : -1;
    const connect =
      timing.connectEnd !== -1
        ? roundMilliSecs(timing.connectEnd - timing.connectStart)
        : -1;
    const ssl =
      timing.secureConnectionStart !== -1
        ? roundMilliSecs(timing.connectEnd - timing.secureConnectionStart)
        : -1;
    const wait =
      timing.responseStart !== -1
        ? roundMilliSecs(timing.responseStart - timing.requestStart)
        : -1;
    const receive =
      timing.responseEnd !== -1
        ? roundMilliSecs(timing.responseEnd - timing.responseStart)
        : -1;
    const total = [blocked, dns, connect, wait, receive].reduce(
      (pre, cur) => (cur > 0 ? cur + pre : pre),
      0
    );
    networkEntry.timings = {
      blocked,
      dns,
      connect,
      ssl,
      wait,
      send: 0, // not exposed via RT api
      receive,
      total: roundMilliSecs(total),
    };
  }

  stop() {
    const context = this.driver.context;
    context.on('request', this._onRequest.bind(this));
    context.on('response', this._onResponse.bind(this));
    context.on('requestfinished', this._onRequestCompleted.bind(this));
    context.on('requestfailed', this._onRequestCompleted.bind(this));
    return this.results;
  }
}
