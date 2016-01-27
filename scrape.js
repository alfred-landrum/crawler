'use strict';

var _ = require('lodash');
var cheerio = require('cheerio');
var conf = require('./config');
var contentType = require('content-type');
var request = require('request-promise');
var request_errors = require('request-promise/errors');
var urlmod = require('url');

// Given an HTML document, parse out links and images.
// Only return gif, jpg, or png images. Only considers img.src,
// ignoring img.srcset. Also ignores inline data images (data:).
function parse(body, url) {
    var $ = cheerio.load(body);

    // Ensure we return absolute urls.
    var abs = urlmod.resolve.bind(null, url);
    // http & https only
    var proto = function(url) {
        return url.startsWith('http');
    }
    // only gif, png, and jpg files
    var exts = ['.gif','.png','.jpg']
    var imgext = function(url) {
        var pathname = urlmod.parse(url).pathname;
        return _.any(exts, function(ext) {
            return pathname.endsWith(ext)
        });
    }

    var images = $('img').map(function() {
        return $(this).attr('src');
    }).get()
        .map(abs)
        .filter(proto)
        .filter(imgext);

    var links = $('a').map(function() {
        return $(this).attr('href');
    }).get()
        .map(abs)
        .filter(proto);

    return {
        images: _.uniq(images),
        links: _.uniq(links),
    };
}

// Make a url request and parse out the image and links on the page.
function scrape(url) {
    return request({
        uri: url,
        timeout: conf.get('request_timeout_secs') * 1000,
        resolveWithFullResponse: true,
    })
    .then(function(response) {
        // XXX: Should check the response header as soon as we get it,
        // and not wait till we've downloaded the whole non-html response body.
        var ctype = contentType.parse(response);
        if (ctype.type !== 'text/html') {
            return { images: [], links: [] };
        }

        // If we were redirected to a new url, we need that new url
        // to resolve relative to absolute urls.
        var body_url = response.request.uri.href;
        return parse(response.body, body_url);
    })
    .catch(request_errors.StatusCodeError, function(reason) {
        throw new Error('status error ' + reason.response.statusCode);
    })
    .catch(request_errors.RequestError, function(reason) {
        throw new Error('request error ' + reason.cause.code);
    })
}

module.exports = scrape;
