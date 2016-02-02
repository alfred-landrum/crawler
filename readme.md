## Image link crawler

A toy web crawling service that records image links.

### Running
The service requires a Redis instance and uses an AWS SQS queue. All configuration can be supplied with environment variables. At a minimum, you'll want to set:

* PORT - the port to listen on.
* CRAWLER_SQS_QUEUE_NAME - name of the AWS SQS queue to use; will create if needed.
* CRAWLER_REDIS_URL - the 'redis:' url for your Redis instance.

This uses the AWS node.js SDK, so you may also need to set the usual AWS environment variables like:

* AWS_DEFAULT_REGION
* AWS_ACCESS_KEY_ID
* AWS_SECRET_ACCESS_KEY

Running a single instance of the service is simple:
```bash
$ npm install
$ npm start
```

By design, you can dynamically scale up by dynamically adding more instances. You can easily scale down by killing instances, with no need to worry about a graceful shutdown or the like.

### Service API

#### POST /new
Expects a JSON formatted list of initial urls. Returns an object containing at least the key 'job_id'.
```json
{
    "job_id": "297c9280-c491-11e5-af00-674d1da0e3d8",
}
```

#### GET /status/:job_id
Returns a status object with the number of pages scanned and queued, and current count of image urls recorded. A 'finished' boolean reports if the job has completed.
```json
{
    "job_id":"297c9280-c491-11e5-af00-674d1da0e3d8",
    "pages_scanned":100,
    "pages_queued":50,
    "images":343,
    "finished":false,
}
```

#### GET /results/:job_id
If job has completed, returns a JSON formatted list of the image urls found during crawling. Returns 404 if job has not completed.

### Implementation
Service instances are stateless, using Redis as a working memory store, and SQS as a task queue. SQS has at-least-once delivery semantics; hence, task operations and sub-operations are designed to be idempotent.

A node is the pairing of a url and height, and represents a logical entity to process for image link collection. Service instances pull processing tasks from SQS, with two types of tasks: job cleaning tasks, used to finalize a crawling job, and node scraping tasks. Scraping a node means downloading the content of the node's url and saving its image links. If the node's height is non-zero, new nodes with a decremented height are created from its url's href links, and scraping tasks are enqueued for them. Crawling jobs are initiated by enqueueing scraping tasks for each root node specified by the url list & maximum height in the "/new" api call.

A common occurrence is that the same url will show up in nodes at different heights within the same job. (Consider the common headers and footers typically seen on all the pages of an organizations web site.) Care is taken to avoid duplicate page downloading and parsing. Processed nodes are recorded in the 'node-done' set in Redis. Additionally, the links found from any url are also stored in Redis, for the lifetime of the job. To understand why, consider two nodes A and B, whose urls are the same, but their heights differ. If the first node processed is A, then when processing B:
- if B's height is the same as A, then B is exactly the same node, so no further work is needed.
- if B's height is lower than A, no work is needed, as processing B will not lead to any new nodes for consideration.
- if B's height is higher than A, we don't need to re-download the url. However, we do need to continue processing B's child nodes, as they will eventually lead to new nodes we wouldn't reach by processing A.

Since nodes won't be processed in any guaranteed ordering (due to the SQS task queue), all of the above cases may occur during crawling.

### Shortcomings, bugs, todos
There's obviously better error handling that could be done. As commented in the code, if an error is thrown during task handling, we will retry the task. This is useful for transient errors, but terrible if the same task is stuck in the queue forever. SQS has a dead letter queue feature that could be useful for this, but I haven't implemented it.

The default request and SQS message visibility timeouts are set such that there's a reasonable chance at downloading and parsing the page before SQS makes the scrape task visible again. However, that's no guarantee: the request timeout doesn't necessarily cover all network related timeouts (dns lookup, TCP connection establishment, slow server data delivery).

When crawling large sites, I've seen instances where many of the same url's end up in the task queue at the beginning of the job. I believe this is because many of the instances race to schedule nodes in enqueue_scrapes(). I think of these as very 'dense' sites near their roots. Since we use a queue to record nodes, we are effectively breadth-first searching the tree. An interesting experiment would be to find and use a LIFO/stack based task system; we would then do a depth first search in the tree, and perhaps workers wouldn't all be racing to put the same links in the task queue.

### Misc
If you've never seen the (in)famous Stackoverflow HTML/regex answer, it's worth a read for the laughs.
- http://stackoverflow.com/questions/1732348/regex-match-open-tags-except-xhtml-self-contained-tags
