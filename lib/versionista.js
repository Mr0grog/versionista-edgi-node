'use strict';

const csvParse = require('csv-parse');
const crypto = require('crypto');
const stream = require('stream');
const jsdom = require('jsdom');
const mime = require('mime-types');
const unzip = require('unzip-stream');
const util = require('util');
const createClient = require('./client');
const flatten = require('./flatten');
const {xpath, xpathArray, xpathNode} = require('./xpath');

const csvParsePromise = util.promisify(csvParse);

/**
 * @typedef {Object} VersionistaSite
 * @property {String} name
 * @property {String} url
 * @property {Date} lastChange
 */

/**
 * @typedef {Object} VersionistaPage
 * @property {String} url
 * @property {String} versionistaUrl
 * @property {String} title
 * @property {Date} lastChange
 * @property {Number} totalVersions
 */

/**
 * @typedef {Object} VersionistaVersion
 * @property {String} versionId
 * @property {String} pageId
 * @property {String} siteId
 * @property {String} url
 * @property {Date} date
 * @property {Boolean} hasContent
 * @property {Number} errorCode
 * @property {Date} lastDate
 * @property {Number} status
 * @property {Number} length
 * @property {String} contentType
 * @property {Number} loadTime
 * @property {Array<String>} redirects
 * @property {String} title
 * @property {String} [diffWithPreviousUrl]
 * @property {Date} [diffWithPreviousDate]
 * @property {String} [diffWithFirstUrl]
 * @property {Date} [diffWithFirstDate]
 * @property {String} [diffWithPreviousSafeUrl]
 * @property {Date} [diffWithPreviousSafeDate]
 * @property {String} [diffWithFirstSafeUrl]
 * @property {Date} [diffWithFirstSafeDate]
 */

/**
 * @typedef {Object} VersionistaDiff
 * @property {Number} length The length of the diff in characters
 * @property {String} hash A SHA 256 hash of the diff
 * @property {String} content The diff itself
 */

const versionistaSourceAdditionsPattern =
  /\n?<!--\s*Versionista general\s*-->[^]*?<!--\s*End Versionista general\s*-->\n?/i;

/**
 * Provides access to data from a Versionista account.
 */
class Versionista {
  /**
   * Creates an instance of Versionista.
   * @param {Object} options
   * @param {String} options.email E-mail for Versionista account
   * @param {String} options.password Password for Versionista account
   */
  constructor (options) {
    this.client = createClient(options && options.client || {});
    this.logIn = this.logIn.bind(this, options.email, options.password);
  }

  /**
   * Make an HTTP request to Versionista. This is largely a wrapper around
   * the request module, but returns a promise and can optionally parse the
   * result with JSDOM.
   * @param {Object|String} options The URL to get or a `request` options Object
   * @param {Boolean} [options.parseBody=true] If true, return a JSDom widow
   *        object instead of a HTTP response. The window will have two
   *        additional properties:
   *        - httpResponse: The response object
   *        - requestDate: A date object representing when the request was made
   * @returns {Promise<HttpResponse|Window>}
   */
  request (options) {
    if (typeof options === 'string') {
      options = {url: options};
    }

    if (!('parseBody' in options)) {
      options.parseBody = true;
    }

    return this.client(options)
      .then(response => {
        const contentType = response.headers['content-type'] || '';
        const mightBeHtml = contentType.startsWith('text/html') ||
          !!response.body.toString().match(/^[\s\n]*</) ||
          response.body.toString() === '';

        if (options.parseBody && mightBeHtml) {
          const dom = new jsdom.JSDOM(response.body, {url: options.url});
          dom.window.httpResponse = response;
          dom.window.requestDate = new Date();
          return dom.window;
        }
        else if (options.stringifyHtml && mightBeHtml) {
          response.body = response.body.toString();
          return response;
        }
        else {
          return response;
        }
      });
  }

  /**
   * Log in to Versionista.
   * @returns {Promise}
   */
  logIn (email, password) {
    if (!this._loggedIn) {
      this._loggedIn = this.request({
        url: 'https://versionista.com/login',
        method: 'POST',
        form: {em: email, pw: password},
        followRedirect: false
      })
        .then(window => {
          if (window.httpResponse.body.match(/log in/i)) {
            const infoNode = window.document.querySelector('.alert');
            const details = infoNode ? ` (${infoNode.textContent.trim()})` : '';
            throw new Error(`Could not log in${details}`);
          }
        });
    }
    return this._loggedIn;
  }

  /**
   * Get an array of the sites in the Versionista Account.
   * @returns {Promise<VersionistaSite[]>}
   */
  getSites () {
    return this.request('https://versionista.com/home?show_all=1')
      .then(window => {
        const rows = Array.from(
          window.document.querySelectorAll('.sorttable > tbody > tr'));

        return rows.map(row => {
          const link = row.querySelector('a.kwbase');
          // There's no longer any reliable class for "time since last change",
          // but the cell has the ID `react_DashSiteChange{siteId}`
          const updateElement = row.querySelector('[id*="DashSiteChange"] .h');
          let lastUpdateSecondsAgo = 0;
          if (updateElement) {
            lastUpdateSecondsAgo = parseFloat(updateElement.textContent);
          }
          else {
            // It appears that if there were no updates in the past year or so,
            // the `.h` element will be replaced with `.anev`. This is
            // imperfect, but basically just treat it as "1 year ago."
            if (row.querySelector('[id*="DashSiteChange"] .anev')) {
              lastUpdateSecondsAgo = 1000 * 60 * 60 * 24 * 365;
            }
            else {
              throw new Error('Could not find "since" field on the sites page.');
            }
          }

          return {
            id: parseVersionistaUrl(link.href).siteId,
            name: link.textContent.trim(),
            url: link.href,
            lastChange: (Number.isNaN(lastUpdateSecondsAgo))
              ? null
              : new Date(window.requestDate - lastUpdateSecondsAgo * 1000)
          };
        });
      });
  }

  /**
   * Get an array of tracked pages for a given site.
   * @param {String} siteUrl URL of site page on Versionista
   * @returns {Promise<VersionistaPage[]>}
   */
  getPages (siteUrl) {
    return this.request(siteUrl).then(window => {
      const pagingUrls = getPagingUrls(window);

      let allPages = [getPageDetailData(window)];
      allPages = allPages.concat(pagingUrls.slice(1).map(pageUrl => {
        return this.request(pageUrl).then(getPageDetailData);
      }));

      return Promise.all(allPages).then(flatten);
    });
  }

  /**
   * Get an array of versions (in ascending order by date) for a given page.
   * @param {String} pageUrl URL of page details page on Versionista
   * @returns {Promise<VersionistaVersion[]>}
   */
  getVersions (pageUrl) {
    const page = parseVersionistaUrl(pageUrl);

    const versionDataForRow = (versionRow) => {
      const linkNode = xpathNode(versionRow, "./td[2]/a");
      let url = linkNode && linkNode.href;
      const hasContent = !!url;
      if (!url) {
        const versionId = versionRow.id.match(/^version_([^_]+)/)[1];
        url = joinUrlPaths(pageUrl, versionId);
      }

      const dateNode = xpathNode(versionRow, "./td[2]//*[@class='gmt']");
      if (!dateNode) {
        throw new Error(`Could not find date field for version "${url}"`);
      }
      const timestamp = 1000 * parseFloat(dateNode.textContent);
      const date = Number.isNaN(timestamp) ? null : new Date(timestamp);

      let errorCode;
      const errorCodeNotices = versionRow.querySelectorAll('.failpage');
      if (errorCodeNotices.length > 1) {
        throw new Error(`More than one error code for version "${url}"`);
      }
      else if (errorCodeNotices.length) {
        errorCode = errorCodeNotices[0].title.match(/:\s+(\d{3})\D/)[1];
      }

      return Object.assign(parseVersionistaUrl(url), {
        url,
        date,
        hasContent,
        errorCode
      });
    }

    function formatComparisonUrl(version, compareTo = {versionId: 0}) {
      return `https://versionista.com/${version.siteId}/${version.pageId}/${version.versionId}:${compareTo.versionId}/`;
    }

    function getVersionCsvUrl(page) {
      return `https://versionista.com/download/page-${page.siteId}-${page.pageId}.csv`;
    }

    function parseVersionsCsv(csvString) {
      return csvParsePromise(csvString.toString(), {
        cast: true,
        cast_date: true,
        columns (names) {
          // lower-case, replace spaces with `_`, remove parentheticals:
          // 'Load time' -> 'load_time'
          const result = names.map(name =>
            name.toLowerCase().replace(/\s+\(.+?\)/g, '').replace(/\s/g, '_'));

          // Validate
          const columns = [
            'first_seen',
            'last_seen',
            'response_code',
            'size',
            'mime_type',
            'load_time',
            'redirected_to'
          ];
          columns.forEach(name => {
            if (!result.includes(name)) throw new Error(`Page CSV is missing required columns: ${columns.join(', ')}`);
          });

          return result;
        }
      });
    }

    const versionsFromPage = this.request(pageUrl).then(window => {
      const versionRows = Array.from(window.document.querySelectorAll(
        '#pageTableBody > tr.version'));
      let oldestVersion;
      let previousVersion;
      let oldestSafeVersion;
      let previousSafeVersion;

      return versionRows.reverse().map(row => {
        const version = versionDataForRow(row);

        // Create links and diff info for previous and first versions
        if (previousVersion) {
          version.diffWithPreviousUrl = formatComparisonUrl(version, previousVersion);
          version.diffWithPreviousDate = version.date;
          version.diffWithFirstUrl = formatComparisonUrl(version, oldestVersion);
          version.diffWithFirstDate = oldestVersion.date;

          if (previousSafeVersion && previousSafeVersion !== previousVersion) {
            version.diffWithPreviousSafeUrl = formatComparisonUrl(version, previousSafeVersion);
            version.diffWithPreviousSafeDate = version.date;
            version.diffWithFirstSafeUrl = formatComparisonUrl(version, oldestSafeVersion);
            version.diffWithFirstSafeDate = oldestSafeVersion.date;
          }
        }
        else {
          oldestVersion = version;
        }

        previousVersion = version;
        if (!version.errorCode) {
          previousSafeVersion = version;
          oldestSafeVersion = oldestSafeVersion || version;
        }

        return version;
      });
    });

    const csvMetadata = this.request({url: getVersionCsvUrl(page), parseBody: false})
      .then(response => parseVersionsCsv(response.body))
      .then(csv => {
        // Create timestamp lookup for CSV data (the CSVs have no IDs)
        const csvByDate = new Map();
        csv.forEach(row => csvByDate.set(row.first_seen.getTime(), row));
        return csvByDate;
      });

    // Combine in-page and CSV-based data
    return Promise.all([versionsFromPage, csvMetadata])
      .then(([versions, csv]) => {
        return versions.map(version => {
          const csvRow = csv.get(version.date.getTime());
          if (!csvRow) {
            throw new Error(`No CSV row for version '${version.siteId}/${version.pageId}/${version.versionId}'`);
          }

          Object.assign(version, {
            lastDate: csvRow.last_seen,
            status: parseInt(csvRow.response_code, 10),
            length: csvRow.size,
            contentType: csvRow.mime_type,
            loadTime: csvRow.load_time,
            redirects: csvRow.redirected_to ? [csvRow.redirected_to] : null,
            title: csvRow.title || null
          });

          return version;
        });
      });
  }

  /**
   * Get the raw content of a given version of an HTML page.
   * TODO: should return an object indicating type (so we can do correct file
   * extensions for PDF, mp4, etc.)
   * @param {String} versionUrl
   * @param {Number} retries Number of times to retry if there's a cache timeout
   * @returns {Promise<String|Buffer>}
   */
  getVersionRawContent (versionUrl, retries = 2) {
    // This is similar to getVersionDiffHtml, but we get to skip a step (yay!)
    // The "api" for this is available directly at versionista.com.
    const apiUrl = versionUrl.replace(
      /(versionista.com\/)(.*)$/,
      '$1api/ip_url/$2/raw');

    return this.request({url: apiUrl, parseBody: false})
      .then(response => {
        if (response.statusCode >= 400) {
          const error = new Error(`Invalid version URL: '${versionUrl}'`);
          error.code = 'VERSIONISTA:INVALID_URL';
          throw error;
        }

        return this.request({
          url: response.body,
          // The URL from the API is time limited, so prioritize the request
          immediate: true,
          // A version may be binary data (for PDFs, videos, etc.)
          encoding: null,
          parseBody: false,
          stringifyHtml: true
        });
      })
      // The raw source is the text of the `<pre>` element. A different type of
      // result (called "safe" in versionista's API) gets us an actual webpage,
      // but it appears that the source there has been parsed, cleaned up
      // (made valid HTML), and had Versionista analytics inserted.
      .then(response => {
        let mimeExtension = mime.extension(response.headers['content-type']);
        const buildResult = (extras) => {
          const result = Object.assign({
            headers: response.headers,
            body: response.body,
            extension: mimeExtension ? `.${mimeExtension}` : ''
          }, extras);
          result.hash = hash(result.body);
          result.length = Buffer.byteLength(result.body, 'utf8');
          return result;
        };

        // Sometimes a version may have no content (e.g. a page was removed).
        // This is OK.
        if (response.body.toString() === '') {
          return buildResult({body: ''});
        }
        // Are we dealing with HTML?
        else if (typeof response.body === 'string') {
          let source = response.body;

          if (/^<h\d>Cache expired<\/h\d>/i.test(source)) {
            // fall through to the error if there are no more retries
            if (retries) {
              return this.getVersionRawContent(versionUrl, retries - 1);
            }
          }
          else {
            // For some reason Versionista seems to insert some blank lines
            if (source.startsWith('\n\n\n')) {
              source = source.slice(3);
            }
            // Clear out Versionista additions (even though there's nothing
            // actually between these comments in `raw` responses).
            source = source.replace(versionistaSourceAdditionsPattern, '');

            return buildResult({body: source});
          }
        }
        else if (Buffer.isBuffer(response.body)) {
          return buildResult({body: response.body});
        }

        // FAILURE!
        const error = new Error(`Can't find raw content for ${versionUrl}`);
        error.code = 'VERSIONISTA:NO_VERSION_CONTENT';
        error.urls = [versionUrl, apiUrl, response.request.uri.href];
        error.receivedContent = response.body;
        throw error;
      });
  }

  getVersionArchive (pageUrl) {
    const createArchiveUrl = joinUrlPaths(pageUrl, 'archive');
    return this.request({
      url: createArchiveUrl,
      parseBody: false,
      retryIf: response => response.statusCode !== 200
    })
      .then(response => {
        if (response.statusCode !== 200) {
          throw new Error(`Error creating archive for ${pageUrl}: ${response.body}`);
        }

        const startTime = Date.now();
        const pollForReadiness = (url, interval = 1 * 1000, maxTime = 5 * 60 * 1000) => {
          const cacheBreaker = `?${Math.random()}`;
          url = url + cacheBreaker;
          return this.request({url, method: 'HEAD', parseBody: false})
            .then(response => {
              if (response.statusCode === 200) {
                return true;
              }
              else if (Date.now() > startTime + maxTime) {
                throw new Error(`Timed out requesting archive for ${pageUrl}`);
              }
              else {
                return new Promise(resolve => {
                  setTimeout(
                    () => resolve(pollForReadiness(url, interval, maxTime)),
                    interval
                  );
                });
              }
            });
        };

        const archiveUrl = `https://s3.amazonaws.com/versionista-packs/${response.body}`;
        return pollForReadiness(archiveUrl)
          .then(() => this.request({
            url: archiveUrl,
            immediate: true,
            encoding: null,
            parseBody: false
          }))
          .then(response => response.body);
      });
  }

  /**
   * Returns a stream of *file* entry objects. These are basically `Entry`
   * objects from the `unzip-stream` library, with a few additions:
   * - {Date} date  A date object representing the parsed version capture date
   * - {String} extension  The file extension
   * - Emits a `hash` event with the file's SHA-256 hash as a buffer
   *
   * This conveniently also skips directory entries, as we don't ever expect
   * them to be present in Versionista archives.
   *
   * Note that you MUST either read the entirety of each entry object stream OR
   * call `.autodrain()` on it. Failure to do so could leave memory in a bad
   * state :(
   *
   * @param {String} pageUrl
   * @returns {Entry}
   */
  getVersionArchiveEntries (pageUrl) {
    const entryStream = new stream.PassThrough({objectMode: true});
    const parseArchiveEntryName = this.parseArchiveEntryName;

    // FIXME: should really stream from client
    this.getVersionArchive(pageUrl)
      .then(content => {
        // TODO: clean up all the error juggling here with pumpify
        const contentStream = new stream.PassThrough();
        contentStream.end(content);
        contentStream
          .pipe(unzip.Parse())
          .on('error', error => entryStream.emit('error', error))
          .pipe(stream.Transform({
            objectMode: true,
            transform: function (entry, encoding, callback) {
              if (entry.type === 'File') {
                Object.assign(entry, parseArchiveEntryName(entry.path))

                entry
                  .pipe(crypto.createHash('sha256'))
                  .on('data', hash => entry.emit('hash', hash));

                entry.pause();
                callback(null, entry);
              }
              else {
                entry.autodrain();
                callback();
              }
            }
          }))
          .on('error', error => entryStream.emit('error', error))
          .pipe(entryStream);
      })
      .catch(error => {
        process.nextTick(() => entryStream.emit('error', error));
      });

    return entryStream;
  }

  parseArchiveEntryName (fileName) {
    const [_, year, month, day, hour, minute, second, extension = ''] =
      fileName.match(/^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)[^\.]*(\..*)?$/);
    const isoDate = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
    const date = new Date(isoDate);
    return {date, extension};
  }

  /**
   * Get information about a diff between two versions (including the diff
   * itself). Note this May return `null` if there is no diff (e.g. if
   * Versionista got no content/no response when it captured the version).
   * @param {String} diffUrl
   * @param {string} [diffType='only']
   * @returns {Promise<VersionistaDiff>}
   */
  getVersionDiff (diffUrl, diffType) {
    diffType = diffType || 'only';
    // This is a little bit of a tortured procedure:
    // The diff URL (e.g. https://versionista.com/74273/6221569/10485802:0/)
    // redirects to another domain that holds the diff content, like:
    // http://52.90.238.162/pa/FzGDbLeKO8hXqBifWxAukL69cLIjxUaqXL3Y6xMrRf9bgM12mizFDCWhwvDGBFSI/
    let diffHost;
    return this.request({url: diffUrl, parseBody: false})
      // On the diff host, there is an API that serves URLs for types of diffs:
      // http://{host}/api/ip_url/{path of diff page}/{diff type}
      // - edits: "rendered: single page" in UI
      // - screenshots: "rendered: screenshots" in UI
      // - html: "source: formatted" in UI
      // - filtered: "source: filtered" in UI
      // - only: "source: changes only" in UI (this is the default for us)
      // - text: "text" in UI
      // - text_only: "text: changes only" in UI
      .then(response => {
        const actualUri = response.request.uri;
        const status = response.statusCode;

        // Bad comparison URLs usually redirect to normal Versionista pages
        if (status >= 400 || actualUri.host.includes('versionista.com')) {
          const error = new Error(`Invalid diff URL: '${diffUrl}'`);
          error.code = 'VERSIONISTA:INVALID_URL';
          throw error;
        }

        diffHost = `${actualUri.protocol}//${actualUri.host}`;
        return `${diffHost}/api/ip_url${actualUri.path}${diffType}`;
      })
      .then(apiUrl => this.request({
        url: apiUrl,
        parseBody: false,
        immediate: true
      }))
      // That API returns a URL for the actual diff content, so fetch that
      .then(response => {
        if (response.statusCode >= 400) {
          const error = new Error(
            `API Error from '${response.request.href}' (Diff URL: ${diffUrl}): ${response.body}`);
          error.code = 'VERSIONISTA:API_ERROR';
          throw error;
        }

        let finalUrl = response.body;
        if (!/^http(s)?:\/\//.test(response.body)) {
          finalUrl = `${diffHost}${response.body}`;
        }

        return this.request({
          url: finalUrl,
          parseBody: false,
          immediate: true
        });
      })
      .then(response => {
        // A diff can be empty in cases where the version was a removed page
        if (!response.body) {
          return null;
        }

        // Make hashes better for comparison by removing Versionista-specific
        // metadata, scripting and styling
        let hashableBody = response.body || '';
        if (typeof hashableBody === 'string') {
          hashableBody = hashableBody
            .replace(versionistaSourceAdditionsPattern, '')
            .trim();
        }

        return {
          hash: hash(hashableBody),
          length: hashableBody.length,
          content: response.body
        }
      });
  }
}

[
  'getSites',
  'getPages',
  'getVersions',
  'getVersionRawContent',
  'getVersionArchive',
  'getVersionDiff'
].forEach(method => {
  const implementation = Versionista.prototype[method];
  Versionista.prototype[method] = function () {
    return this.logIn().then(() => implementation.apply(this, arguments));
  }
});

function parseVersionistaUrl (url) {
  const ids = url.match(/^http(s?):\/\/[^\/]+\/(.*)$/)[2].split('/');
  return {
    siteId: ids[0],
    pageId: ids[1],
    versionId: ids[2] && ids[2].split(':')[0]
  };
}

function hash (text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function joinUrlPaths (basePath, ...paths) {
  return paths.reduce((finalPath, urlPath) => {
    const delimiter = finalPath.endsWith('/') ? '' : '/';
    return finalPath + delimiter + urlPath;
  }, basePath);
}

function getPagingUrls (window) {
  return Array.from(window.document.querySelectorAll('.pagination li a'))
    // The first and last links are "previous" / "next", so drop them
    .slice(1, -1)
    .map(link => link.href)
};

function getPageDetailData (window) {
  const xpathRows = xpath(window.document, "//div[contains(text(), 'URL')]/../../../following-sibling::tbody/tr");
  return xpathRows.map(row => {
    let lastChange = null;
    const updateTimeText = xpathNode(row, "./td[8]").textContent.trim();
    if (!/^(\d*(\.\d*)?|[\-–—])$/.test(updateTimeText)) {
      throw new Error(oneLine(`Expected update time to be a numeric timestamp,
        but got "${updateTimeText}" (${window.location.href})`));
    }
    else {
      const timestamp = parseFloat(updateTimeText);
      if (!Number.isNaN(timestamp)) {
        lastChange = new Date(1000 * timestamp);
        if (lastChange.getUTCFullYear() < 2000) {
          throw new Error(oneLine(`Last change time for page does not seem
            correct: "${lastChange}" from text "${updateTimeText}"
            (${window.location.href})`));
        }
      }
    }

    const totalVersions = parseFloat(xpathNode(row, "./td[7]").textContent.trim());
    const versionistaUrl = xpathNode(row, "./td[a][2]/a").href;

    // Versionista's link to the live page used to be a redirect like:
    //   https://versionista.com/viewUrl?{unencoded_destination_URL}
    // It now appears just be a regular link. Try and handle both cases in case
    // they switch it up again.
    let remoteUrl = xpathNode(row, "./td[a][1]/a").href;
    if (/^(\/|https?:\/\/[^\/]*versionista\.com)/i.test(remoteUrl)) {
      const queryIndex = remoteUrl.indexOf('?');
      if (queryIndex === -1) {
        // Versionista no longer gives us a link to the original content if the
        // last scan failed. Now we try and piece it together from the site URL
        // at the top of the page and the path listed as text in this row.
        const remotePathNode = xpathNode(row, "./td[4]/a");
        if (!remotePathNode) {
          throw new Error(`Cannot find this page's URL path in its site: "${remoteUrl}"`);
        }
        const remotePath = remotePathNode.textContent.trim();

        // Sometimes it's actually a full URL, in which case we are good to go.
        if (/^(http|https|ftp):/.test(remotePath)) {
          remoteUrl = remotePath;
        }
        // But usually it's a path, so we have to go find the base URL.
        else if (remotePath.startsWith('/')) {
          // NOTE: I suspect this selector is pretty prone to failure.
          const remoteBaseUrlNode = window.document.querySelector(
            '#siteOptions a[title*="live site"]');
          if (!remoteBaseUrlNode || !remoteBaseUrlNode.href.startsWith('http')) {
            throw new Error(`Can't find base URL of web site to use with URL path: "${remotePath}" (Versionista: "${remoteUrl}")`);
          }
          const remoteBaseUrl = remoteBaseUrlNode.href.replace(/\/$/, '');
          remoteUrl = remoteBaseUrl + remotePath;
        }
        // Otherwise, who knows!
        else {
          throw new Error(`The URL path for this page doesn't seem to be valid: "${remotePath}" (Versionista: ${remoteUrl})`);
        }
      }
      remoteUrl = remoteUrl.slice(queryIndex + 1);
    }

    // Sanity-check totalVersions
    if (!Number.isNaN(totalVersions) && totalVersions > 10000) {
      throw new Error(oneLine(`A number was found for totalVersions, but it doesn’t
        look like an actual version count! Versionista’s UI may have changed.
        (${versionistaUrl})`));
    }

    return {
      id: parseVersionistaUrl(versionistaUrl).pageId,
      url: remoteUrl,
      versionistaUrl: versionistaUrl,
      title: xpathNode(row, "./td[a][3]").textContent.trim(),
      lastChange,
      totalVersions
    };
  });
};

function versionDataFromLink (versionLink) {

}

function oneLine (string) {
  return string.replace(/\n\s+/g, ' ');
}

module.exports = Versionista;
