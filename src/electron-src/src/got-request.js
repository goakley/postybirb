const {
  remote,
} = require('electron');
const Got = require('got');
const Request = require('request');
const FormData = require('form-data');
const {
  CookieJar
} = require('tough-cookie');
const setCookie = require('set-cookie-parser');

const {
  session,
} = require('electron').remote;

const agent = `${remote.getCurrentWebContents().userAgent}`
const got = Got.extend({
  headers: {
    'User-Agent': agent
  }
});

const request = Request.defaults({
  headers: {
    'User-Agent': agent
  }
});

exports.get = function get(url, cookieUrl, cookies, profileId, options) {
  return new Promise((resolve, reject) => {
    const cookieJar = new CookieJar();
    if (cookies && cookies.length) {
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        cookieJar.setCookie(`${cookie.name}=${cookie.value}`, cookieUrl, () => {});
      }
    }

    const opts = Object.assign({
      cookieJar
    }, options);

    got(url, opts)
      .then((res) => {
        if (res.headers['set-cookie'] && profileId) { // TODO: I think I only implemented this because of SoFurry. Might be worth removing this logic.
          const _cookies = setCookie.parse(res, {
            decodeValues: false
          });
          const cookieSession = session.fromPartition(`persist:${profileId}`).cookies;
          _cookies.forEach((c) => {
            c.domain = c.domain || res.request.gotOptions.host;
            const converted = _convertCookie(c);
            const now = new Date();
            converted.expirationDate = now.setMonth(now.getMonth() + 4); // add 4 months
            cookieSession.set(converted)
              .catch( function(err) {
                if (err) {
                  console.warn(err, this);
                }
              }.bind(converted));
          });
        }
        resolve(res);
      }).catch((err) => {
        if (!err.body) {
          err.body = err;
        }
        resolve(err);
      });
  });
};

// To be honest, Request is easier to use IMO since it has better option support than GOT.
exports.requestGet = function requestGet(url, cookieUrl, cookies, options) {
  return new Promise((resolve, reject) => {
    const cookieJar = request.jar();
    if (cookies && cookies.length) {
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        cookieJar.setCookie(request.cookie(`${cookie.name}=${cookie.value}`), cookieUrl);
      }
    }

    const opts = Object.assign({
      jar: cookieJar,
      followAllRedirects: true
    }, options || {});
    request.get(url, opts, (err, response, body) => {
      if (err) {
        resolve({
          error: err
        });
      } else {
        resolve({
          success: {
            response,
            body,
          },
        });
      }
    });
  });
};

exports.patch = function patch(url, formData, cookieUrl, cookies, options) {
  return new Promise((resolve, reject) => {
    const cookieJar = request.jar();
    if (cookies && cookies.length) {
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        cookieJar.setCookie(request.cookie(`${cookie.name}=${cookie.value}`), cookieUrl);
      }
    }

    const opts = Object.assign({
      formData,
      jar: cookieJar,
      followAllRedirects: true
    }, options || {});
    request.patch(url, opts, (err, response, body) => {
      if (err) {
        resolve({
          error: err
        });
      } else {
        resolve({
          success: {
            response,
            body,
          },
        });
      }
    });
  });
};

exports.post = function post(url, formData, cookieUrl, cookies, options) {
  return new Promise((resolve, reject) => {
    const cookieJar = request.jar();
    if (cookies && cookies.length) {
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        cookieJar.setCookie(request.cookie(`${cookie.name}=${cookie.value}`), cookieUrl);
      }
    }

    const opts = Object.assign({
      formData,
      followAllRedirects: true
    }, options || {});

    if (cookies) {
      Object.assign(opts, {
        jar: cookieJar,
      });
    }

    if (formData instanceof Function) {
      delete opts.formData;
    }

    const req = request.post(url, opts, (err, response, body) => {
      if (err) {
        resolve({
          error: err
        });
      } else {
        resolve({
          success: {
            response,
            body,
          },
        });
      }
    });

    if (formData instanceof Function) {
      formData(req.form());
    }
  });
};

// NOTE: This was created just to make e621 work since e621 doesn't like request for some reason.
// Now that I know how to get files working it might be worthwhile looking into replacing the old stuff using request in the future
exports.gotPost = function gotPost(url, formData, cookieUrl, cookies, options) {
  return new Promise((resolve, reject) => {
    const cookieJar = new CookieJar();
    if (cookies && cookies.length) {
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        cookieJar.setCookie(`${cookie.name}=${cookie.value}`, cookieUrl, () => {});
      }
    }

    const form = new FormData();
    Object.keys(formData).forEach((key) => {
      const val = formData[key];
      if (val.options) { // assume file?
        form.append(key, val.value, val.options);
      } else {
        form.append(key, formData[key]);
      }
    });

    const opts = Object.assign({
      body: form,
      cookieJar,
      followRedirect: true
    }, options);
    got.post(url, opts)
      .then((res) => {
        resolve(res);
      }).catch((err) => {
        resolve(err); // got seems to throw a lot despite a successful post
      });
  });
};

// NOTE: This was created because afterdark speaks graphql and can't use formData.
exports.gotPostJSON = function gotPost(url, body, cookieUrl, cookies, profileId, options) {
  return new Promise((resolve, reject) => {
    const cookieJar = new CookieJar();
    if (cookies && cookies.length) {
      for (let i = 0; i < cookies.length; i++) {
        const cookie = cookies[i];
        cookieJar.setCookie(`${cookie.name}=${cookie.value}`, cookieUrl, () => {});
      }
    }

    const opts = Object.assign({
      body: body,
      cookieJar,
      followRedirect: true
    }, options);
    got.post(url, opts)
      .then((res) => {
        if (res.headers['set-cookie'] && profileId) { // need to re-set the cookies as sessionid can change
          const _cookies = setCookie.parse(res, {
            decodeValues: false
          });
          const cookieSession = session.fromPartition(`persist:${profileId}`).cookies;
          _cookies.forEach((c) => {
            c.domain = c.domain || res.request.gotOptions.host;
            const converted = _convertCookie(c);
            const now = new Date();
            converted.expirationDate = now.setMonth(now.getMonth() + 4); // add 4 months
            cookieSession.set(converted)
              .catch( function(err) {
                if (err) {
                  console.warn(err, this);
                }
              }.bind(converted));
          });
        }
        resolve(res);
      }).catch((err) => {
        resolve(err); // got seems to throw a lot despite a successful post
      });
  });
};

function _convertCookie(cookie) {
  const url = `${cookie.secure ? 'https' : 'http'}://${cookie.domain}${cookie.path || ''}`;
  const details = {
    domain: cookie.domain,
    httpOnly: cookie.httpOnly || false,
    name: cookie.name,
    secure: cookie.secure || false,
    url: url.replace('://.', '://'),
    value: cookie.value,
  };
  return details;
}

exports.convertCookie = _convertCookie;
