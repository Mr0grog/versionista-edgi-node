'use strict';

const request = require('request');

const MAX_SOCKETS = 6;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_12_3) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/56.0.2924.87 Safari/537.36';
const SLEEP_EVERY = 40;
const SLEEP_FOR = 1000;
const MAX_RETRIES = 3;
const MAX_PER_MINUTE = 0;

// LibUV error codes we should attempt to resolve by retrying.
// List of all codes: https://github.com/nodejs/node/blob/8174d0c8cae857296c45b2c448348f2c781f6ace/deps/uv/include/uv.h#L66-L145
const RETRYABLE_ERRORS = [
  'EAI_AGAIN',     // temporary failure
  'EAI_MEMORY',    // out of memory
  'EAI_NONAME',    // unknown node or service
  'EBUSY',         // resource busy or locked
  'ECONNREFUSED',  // connection refused
  'ECONNRESET',    // connection reset by peer
  'ETIMEDOUT'      // connection timed out
];

function createClient ({userAgent = USER_AGENT, maxSockets = MAX_SOCKETS, sleepEvery = SLEEP_EVERY, sleepFor = SLEEP_FOR, maxPerMinute = MAX_PER_MINUTE} = {}) {
  maxPerMinute = maxPerMinute || Infinity; // Allow 0 to imply Infinity

  const cookieJar = request.jar();
  const versionistaRequest = request.defaults({
    jar: cookieJar,
    headers: {'User-Agent': userAgent}
  });

  // Manage simultaneous requests. Request can actually do this natively with
  // its `pool` feature, but that can result in timeouts when a lot of requests
  // are queued up (which is likely here). This also lets us enforce short
  // break periods every few requests.

  let untilSleep = sleepEvery;
  let sleeping = false;
  function sleepIfNecessary () {
    if (sleeping || sleepEvery <= 0) return;

    if (untilSleep > 0) {
      untilSleep--;
    }

    if (untilSleep === 0) {
      sleep();
    }
  }

  function sleep (time = sleepFor) {
    sleeping = true;
    setTimeout(() => {
      sleeping = false;
      untilSleep = sleepEvery;
      doNextRequest();
    }, time);
  }

  let availableSockets = maxSockets;
  let windowStart;
  let windowSize = 60 * 1000; // 1 minute
  let availableInWindow = maxPerMinute;
  const queue = [];
  function doNextRequest () {
    if (availableSockets <= 0 || sleeping) return;

    const now = Date.now();
    if (windowStart) {
      const timeSinceWindowStart = now - windowStart;
      if (timeSinceWindowStart > windowSize) {
        windowStart = now - ((timeSinceWindowStart) % windowSize);
        availableInWindow = maxPerMinute;
      }
    }
    else {
      windowStart = now;
    }

    if (availableInWindow <= 0) {
      sleep( windowSize - (now - windowStart));
      return;
    }

    const task = queue.shift();
    if (task) {
      availableSockets--;
      availableInWindow--;
      versionistaRequest(task.options, (error, response) => {
        availableSockets++;
        sleepIfNecessary();

        const shouldRetry = (error && RETRYABLE_ERRORS.includes(error.code))
          || (response && task.retryIf(response));

        if (shouldRetry && task.retries < MAX_RETRIES) {
          task.retries += 1;
          queue.unshift(task);
          sleep(sleepFor * task.retries * 2);
        }
        else if (error) {
          let message = error.message;
          try {
            message += ` with options ${JSON.stringify(task.options)}`
          }
          catch (jsonError) {
            message += ' with unserializable options';
          }
          const customError = new Error(message);
          customError.code = error.code;
          task.reject(customError);
        }
        else {
          task.resolve(response);
        }

        // NOTE: do this *after* resolving so the resolver has an opportunity
        // queue an immediate next request first.
        process.nextTick(doNextRequest);
      });
    }
  }

  // By default, auto-retry on gateway errors
  const defaultRetryIf = r => (r.statusCode >= 502 && r.statusCode <= 504);

  return function (options) {
    return new Promise((resolve, reject) => {
      const task = {
        options: options,
        retries: (options.retry === false) ? MAX_RETRIES : 0,
        retryIf: options.retryIf || defaultRetryIf,
        resolve,
        reject
      };
      queue[options.immediate ? 'unshift' : 'push'](task);
      doNextRequest();
    });
  };
}

module.exports = createClient;
