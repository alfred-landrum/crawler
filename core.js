'use strict';

var _ = require('lodash');
var store = require('./store');
var uuid = require('uuid');
var queue = require('./queue');
var scrape = require('./scrape');
var Promise = require('bluebird');

var MAX_HEIGHT = 2;

var stats = {
    worker_pre_scrape_dupe: 0,
    worker_pre_scrape_parent: 0,
    worker_post_scrape_dupe: 0,
    worker_schedule_avoid: 0,
    worker_scrape_errors: 0,
    worker_load_links_hit: 0,
};

// Scrape the images & links for this node's url, and store the results.
// Images are intentionally stored before the links so that scrape_node
// can easily tell if we've scraped this url already.
// XXX: If we error during scraping, we will store an empty links list and record
// an error stat. We could add some retry logic if desired.
function scrape_and_store(job_id, node) {
    var images, links;
    var url = node.url;
    var scrape_start = Date.now();
    return scrape(url)
    .catch(function(error) {
        stats.worker_scrape_errors++;
        return { error: error.message, images: [], links: [], };
    })
    .then(function(res) {
        var duration = Date.now() - scrape_start;
        images = res.images;
        links = res.links;

        if (res.error) {
            console.log('scrape_and_store: job', job_id, 'error url', url,
                        'height', node.height, 'duration', duration, 'ms, error ', res.error);
        } else {
            console.log('scrape_and_store: job', job_id, 'success url', url,
                        'height', node.height, 'duration', duration, 'ms, ', images.length, 'images ', links.length, 'links');
        }

        return store.save_images(job_id, images)
    })
    .then(function() {
        return store.save_links(job_id, url, links);
    })
    .then(function() {
        return links;
    });
}

// Queue the nodes for the given urls & height for processing.
// Duplicate scrape tasks can end up on the queue, either because
// a worker gets killed before marking nodes for scheduling, or because
// multiple workers race enqueueing the same node. Not sure how to
// best avoid that while still ensuring idempotency.
function enqueue_scrapes(job_id, urls, height, max_height) {
    // We dont need to enqueue nodes that have already been processed,
    // or already on the queue.
    return store.intersection_with_nodes_scheduled(job_id, urls, height)
    .then(function(already) {
        stats.worker_schedule_avoid += already.length;
        var remaining = _.difference(urls, already);
        var tasks = remaining.map(function(url) {
            return {
                type: 'scrape',
                job_id: job_id,
                node: {
                    url: url,
                    height: height,
                },
                max_height: max_height,
            }
        });
        return store.prequeue_nodes(job_id, remaining, height)
        .then(function() {
            return queue.enqueue_tasks(tasks);
        })
        .then(function() {
            return store.postqueue_nodes(job_id, remaining, height);
        });
    });
}

function process_node(job_id, node, max_height) {

    function scrape_node() {
        // For leaf nodes, there's no case where we may have already scraped
        // the page (due to the update_if_link_done check), so just scrape it.
        if (node.height === 0) {
            return scrape_and_store(job_id, node);
        }

        // Otherwise, see if we already have the links for the page. An example
        // situation is where we already fetched the url for height 0, but now
        // want that url at height 1.
        return store.load_links(job_id, node.url)
        .then(function(db_links) {
            if (db_links) {
                stats.worker_load_links_hit++;
                return db_links;
            }
            return scrape_and_store(job_id, node);
        })
        .then(function(links) {
            return enqueue_scrapes(job_id, links, node.height - 1, max_height);
        });
    }

    // Have we already processed this node, or a node with the
    // same url but higher height? If so, there's no need to do any work.
    return store.check_and_update_node_done(job_id, node, max_height)
    .then(function(result) {
        if (result.done) {
            // check_and_update_node_done marks the node if needed, and will
            // also report 'done' here if it turns out that this scrape task
            // is for an already completed job, so we must do nothing else.
            if (result.parent) {
                stats.worker_pre_scrape_parent++;
            } else {
                stats.worker_pre_scrape_dupe++;
            }
            return;
        }

        return scrape_node()
        .then(function() {
            return store.mark_node_done(job_id, node);
        });
    });
}

function handle_scrape_task(job_id, node, max_height) {
    return process_node(job_id, node, max_height)
    .then(function() {
        return store.is_job_finished(job_id);
    })
    .then(function(finished) {
        if (!finished) {
            return;
        }
        var clean = {
            type: 'clean',
            job_id: job_id,
        };
        return queue.enqueue_tasks([clean]);
    });
}

function handle_clean_task(job_id) {
    return store.clean_job(job_id);
}

function validate_scrape_task(task) {
    if (task.type !== 'scrape') {
        throw new Error('bad scrape task type ' + task.type);
    }
    _.each(['job_id', 'node', 'max_height'], function(prop) {
        if (_.isUndefined(task[prop])) {
            throw new Error('received task missing property ' + prop);
        }
    });
    if (!_.isString(task.node.url)) {
        throw new Error('received task missing url');
    }
    if (! (_.isNumber(task.node.height) && task.node.height >= 0 && task.node.height <= MAX_HEIGHT)) {
        throw new Error('invalid height ' + task.node.height);
    }
}

function validate_clean_task(task) {
    if (task.type !== 'clean') {
        throw new Error('bad clean task type ' + task.type);
    }
    if (!_.isString(task.job_id)) {
        throw new Error('clean task with bad job_id ' + task.job_id);
    }
}

// Called from queue consumer with already parsed JSON task
// and done callback.
function queue_handler(task, done) {
    Promise.try(function() {
        if (!_.isString(task.type)) {
            throw new Error('missing or bad type on task ' + task.type);
        }
        switch (task.type) {
            case 'scrape':
                validate_scrape_task(task);
                return handle_scrape_task(task.job_id, task.node, task.max_height)

            case 'clean':
                validate_clean_task(task);
                return handle_clean_task(task.job_id)

            default:
                throw new Error('unhandled task type ' + task.type);
        }
    })
    .then(function() {
        done();
    }, function(err) {
        console.log('queue_handler: handler failed:', err, err.stack);
        // Reporting this error will prevent the SQS-consumer module
        // from deleting this message from the SQS queue. This is useful
        // if, say, the store is temporarily down such that we cant connect
        // to it. Not so good if we just keep barfing on the same task.
        // SQS's dead letter queue would be useful for repeatedly failed messages.
        done(err);
    });
}

function create_job(urls) {
    var job_id = uuid.v1();
    var height = MAX_HEIGHT;

    return store.new_job(job_id, {
        job_id: job_id,
        urls: urls,
        height: height,
        max_height: height,
    })
    .then(function() {
        return enqueue_scrapes(job_id, urls, height, height);
    })
    .then(function() {
        return job_id;
    });
}

// Resolves to a simple object with status info
function get_status(job_id) {
    return store.get_status(job_id)
    .then(function(status) {
        return _.extend(status, {
            stats: _.clone(stats),
        });
    });
}

// Resolves to null if job is not yet done,
// or list of image urls otherwise.
function get_results(job_id) {
    return store.load_images_if_done(job_id);
}

function core_init() {
    var consumer = queue.register_handler(queue_handler);
    consumer.start();
}

module.exports = {
    create_job: create_job,
    get_status: get_status,
    get_results: get_results,
    init: core_init,
}
