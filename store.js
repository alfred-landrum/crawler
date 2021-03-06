'use strict';

var _ = require('lodash');
var assert = require('assert');
var conf = require('./config');
var Promise = require('bluebird');
var uuid = require('uuid');
var Redis = require('ioredis');

var redis;

// Redis schema
//
// 3 sets are used to track node processing:
// - just before a node scrape task is enqueued, the node is added to the
//   prequeue set.
// - after a node scrape task is enqueued, it is added to the node-scheduled set.
// - when a node has been scraped, either actually downloaded, or effectively
//   scraped because its url has been handled previously, the node is added
//   to the node-done set.
//
// We record scraping results in the images & links sets.
// Job info is recorded in job-start & job-done.
//
// When a job is finished, clean_job() will add a long-ish expiration to the
// job-start, job-done, and images sets. The other sets (node-done, node-scheduled,
// and links) will have a much smaller expiration time set (~2 mins).

function preq_key(job_id) { return 'crawler:' + job_id + ':node-prequeued'; }
function sched_key(job_id) { return 'crawler:' + job_id + ':node-scheduled'; }
function done_key(job_id) { return 'crawler:' + job_id + ':node-done'; }
function links_key(job_id) { return 'crawler:' + job_id + ':links'; }
function images_key(job_id) { return 'crawler:' + job_id + ':images'; }
function job_start_key(job_id) { return 'crawler:' + job_id + ':job-start'; }
function job_done_key(job_id) { return 'crawler:' + job_id + ':job-done'; }

function url_val(url, height) { return 'height:' + height + ':url:' + url; }

// Return a point-in-time snapshot of the count of done, prequeued, and scheduled.
function get_node_sets_counts(job_id) {
    var done, scheduled;
    return redis.multi()
    .scard(preq_key(job_id))
    .scard(sched_key(job_id))
    .scard(done_key(job_id))
    .exec()
    .then(function(result) {
        // see ioredis 'multi' for result format info.
        return {
            prequeued: result[0][1],
            scheduled: result[1][1],
            done: result[2][1],
        };
    });
}

// Resolves to true if the crawling job has finished processing all
// possible nodes.
// - during lifetime of scraping job, done < (scheduled + prequeued)
// - end of job is when done === prequeued.
// - during clean below, we make sure to expire scheduled before done,
//   so that if this check is made after cleanup for some reason,
//   it will still report job as finished.
function is_job_finished(job_id) {
    return get_node_sets_counts(job_id)
    .then(function(result) {
        return result.done >= result.prequeued;
    });
}

// All operations and sub-operations are intentionally idempotent.
function clean_job(job_id) {
    function ensure_done_marker() {
        // We need to ensure that if we're restarting this clean task due to
        // prior failure, or in the case of SQS message duplication, that
        // we leave valid info in the job_done entry.
        return redis.exists(job_done_key(job_id))
        .then(function(exists) {
            if (exists) {
                return;
            }

            var start_info;
            return redis.get(job_start_key(job_id))
            .then(function(_start_info) {
                start_info = JSON.parse(_start_info);
                return get_active_status(job_id)
            })
            .then(function(status) {
                _.extend(status, start_info, {
                    finished_at: new Date().toISOString(),
                });
                // setnx in case we raced with a duplicate handler; they may
                // have already set the job_done_key and removed the node sets,
                // so our info from get_active_status would be invalid.
                return redis.setnx(job_done_key(job_id), JSON.stringify(status));
            });
        });
    }

    return ensure_done_marker()
    .then(function() {
        var keys = [job_done_key(job_id), images_key(job_id)];
        return Promise.map(keys, function(key) {
            return redis.expire(key, conf.get('job_info_linger_secs'));
        });
    })
    .then(function() {
        // We expire the other sets instead of deleting immediately in case
        // a scrape task message is duplicated by SQS. We do these serially
        // (via each instead of map) so that the check in is_job_finished
        // will be correct even if it runs mid-expiration.
        var keys = [
            preq_key(job_id),
            sched_key(job_id),
            done_key(job_id),
            links_key(job_id),
        ];
        return Promise.each(keys, function(key) {
            // The 2 * visibility expiration is based on a visibility epoch
            // on the order of 10's of seconds, and to ensure that this
            // stays around beyond the likely point of SQS message duplication:
            // https://aws.amazon.com/articles/Amazon-SQS/1343#09
            return redis.expire(key, 2 * conf.get('sqs_visibility_secs'));
        });
    });
}


function get_active_status(job_id) {
    return get_node_sets_counts(job_id)
    .then(function(counts) {
        if (counts.scheduled === 0) {
            // This is a non-existent job, or one that is long since completed.
            return null;
        }
        return redis.scard(images_key(job_id))
        .then(function(images) {
            return {
                job_id: job_id,
                pages_scanned: counts.done,
                pages_queued: counts.prequeued - counts.done,
                images: images,
                finished: (counts.prequeued === counts.done),
            };
        });
    })

    var completed, scheduled, images;
    return redis.scard(done_key(job_id))
    .then(function(n) {
        completed = n;
        return redis.scard(sched_key(job_id));
    })
    .then(function(n) {
        scheduled = n;

        if (scheduled === 0) {
            // non-existent job!
            return null;
        }

    });
}

// Resolves to a object with job status, including a boolean 'finished'
// if this job is done.
function get_status(job_id) {
    return redis.get(job_done_key(job_id))
    .then(function(jobdone) {
        if (jobdone) {
            return JSON.parse(jobdone);
        }

        return get_active_status(job_id);
    });
}

// Resolves to list of image urls if done, null otherwise.
function load_images_if_done(job_id) {
    return get_status(job_id)
    .then(function(status) {
        if (!status.finished) {
            return null;
        }
        return load_images(job_id);
    })
}

// Store initial creation info for this job.
function new_job(job_id, info) {
    _.extend(info, {created_at: new Date().toISOString()});
    var value = JSON.stringify(info);
    return redis.setex(job_start_key(job_id), conf.get('job_info_linger_secs'), value);
}

// Given a list of urls that we may want to schedule, return a list
// of arrays that are already in the node-scheduled set. Since we
// never remove nodes from node-scheduled during the crawl, this
// also considers nodes that have already been fully processed (and are
// hence in the node-done set).
//
// note: redis docs say sinter is O(N) on smallest set,
// while sdiff is O(N) on total elements in all sets. Hence
// we use sinter here and then diff on these results in core,
// since node-scheduled will be much larger than urls here.
function intersection_with_nodes_scheduled(job_id, urls, height) {
    if (urls.length === 0) {
        return Promise.resolve([]);
    }
    var values = urls.map(function(url) {
        return url_val(url, height);
    });

    var tmpset = ':tmp:' + uuid.v1();
    return redis.multi()
    .sadd(tmpset, values)
    .sinter(tmpset, sched_key(job_id))
    .del(tmpset)
    .exec()
    .then(function(result) {
        // Extract results; see ioredis 'multi' docs
        // for info on 'multi' result format.
        var intersection = result[1][1];

        // Remove the height:n:url: prefix
        var height_strlen = url_val('', height).length;
        return intersection.map(function(x) {
            return x.slice(height_strlen);
        });
    });
}

function prequeue_nodes(job_id, urls, height) {
    if (urls.length === 0) {
        return Promise.resolve();
    }
    var values = urls.map(function(url) {
        return url_val(url, height);
    });
    return redis.sadd(preq_key(job_id), values);
}

function postqueue_nodes(job_id, urls, height) {
    if (urls.length === 0) {
        return Promise.resolve();
    }
    var values = urls.map(function(url) {
        return url_val(url, height);
    });
    return redis.sadd(sched_key(job_id), values);
}


// Determine if this node requires processing or not:
// a) no processing needed if node already in node-done
// b) if higher height nodes with the same url are in node-done, then mark
//  this url,height has done as well.
// In case of b), we also add the node to the node-done list here.
//
// Returns an object with:
// - done === true if no work needed due to either a) or b)
// - parent === true iff done is true due to case b)
// The parent flag is currently just used for stats tracking.
function check_and_update_node_done(job_id, node, max_height) {
    var url = node.url;
    var height = node.height;
    assert(height <= max_height, 'bad max_height ' + max_height + ' or height ' + height);

    // Calculate url_val's for this node & higher nodes of same url.
    var values = _.map(_.range(max_height - height + 1), function(delta) {
        return url_val(url, height + delta);
    });

    // XXX: The below is_job_finished & smember checks could be combined
    // into a single call to avoid the multiple round trips to redis.
    return is_job_finished(job_id)
    .then(function(finished) {
        if (finished) {
            // We got called after this job has been completed, do nothing.
            return {done: true};
        }

        return Promise.map(values, function(value) {
            return redis.sismember(done_key(job_id), value);
        })
        .then(function(res) {
            var ret = {
                done: _.any(res),
            };
            if (ret.done && !res[0]) {
                // this url,height isnt set, but a parent is, so mark it here.
                return mark_node_done(job_id, node)
                .then(function() {
                    ret.parent = true;
                    return ret;
                })
            }
            return ret;
        });
    });
}

function mark_node_done(job_id, node) {
    return redis.sadd(done_key(job_id), url_val(node.url, node.height));
}

function save_images(job_id, images) {
    if (images.length === 0) {
        return Promise.resolve();
    }
    return redis.sadd(images_key(job_id), images);
}

function load_images(job_id) {
    return redis.smembers(images_key(job_id));
}

function save_links(job_id, url, links) {
    if (links.length === 0) {
        return Promise.resolve();
    }
    var value = JSON.stringify(links);
    return redis.hset(links_key(job_id), url, value);
}

// Return list of links found while scraping url.
// If url has not been scraped, returns null.
function load_links(job_id, url) {
    return redis.hget(links_key(job_id), url)
    .then(function(res) {
        if (res) {
            res = JSON.parse(res);
        }
        return res;
    })
}

function db_init() {
    return new Promise(function(resolve, reject) {
        redis = new Redis(conf.get('redis_url'), {
            enableReadyCheck: true,
        });
        redis.once('ready', resolve);
        redis.once('error', reject);
    });
}

module.exports = {
    is_job_finished: is_job_finished,
    clean_job: clean_job,
    get_status: get_status,
    intersection_with_nodes_scheduled: intersection_with_nodes_scheduled,
    prequeue_nodes: prequeue_nodes,
    postqueue_nodes: postqueue_nodes,
    check_and_update_node_done: check_and_update_node_done,
    mark_node_done: mark_node_done,
    save_images: save_images,
    load_images: load_images,
    save_links: save_links,
    load_links: load_links,
    load_images_if_done: load_images_if_done,
    new_job: new_job,
    init: db_init,
}
