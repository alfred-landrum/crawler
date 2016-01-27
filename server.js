'use strict';

var api = require('./api');
var core = require('./core');
var store = require('./store');
var queue = require('./queue');

function main() {
    return store.init()
    .then(function() {
        return queue.init();
    })
    .then(function() {
        return core.init();
    })
    .then(function() {
        return api.init();
    })
    .then(function() {
        console.log('main: crawler instance running');
    })
    .catch(function(err) {
        console.log('main: unhandled exception, rethrowing: ', err.message);
        throw err;
    })
}

main();
