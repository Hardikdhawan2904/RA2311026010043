# Notification System Design

---

## Stage 1

### REST API Endpoints for Campus Notification Platform

#### Core Endpoints

**1. Get notifications for authenticated student**
```
GET /api/notifications
Authorization: Bearer <token>

Query Parameters:
  page    (integer, default: 1)
  limit   (integer, default: 20)
  type    (string, optional: "Placement" | "Result" | "Event")
  isRead  (boolean, optional)

Response 200:
{
  "notifications": [
    {
      "id": "uuid",
      "type": "Placement",
      "message": "Tesla Inc. hiring",
      "isRead": false,
      "createdAt": "2026-04-22T17:51:30Z"
    }
  ],
  "total": 150,
  "page": 1,
  "limit": 20
}
```

**2. Get a single notification**
```
GET /api/notifications/:id
Authorization: Bearer <token>

Response 200:
{
  "notification": {
    "id": "uuid",
    "type": "Event",
    "message": "tech-fest",
    "isRead": false,
    "createdAt": "2026-04-22T17:51:06Z"
  }
}
```

**3. Mark a notification as read**
```
PATCH /api/notifications/:id/read
Authorization: Bearer <token>

Response 200:
{
  "success": true
}
```

**4. Mark all notifications as read**
```
PATCH /api/notifications/read-all
Authorization: Bearer <token>

Response 200:
{
  "updated": 42
}
```

**5. Get unread notification count**
```
GET /api/notifications/unread-count
Authorization: Bearer <token>

Response 200:
{
  "count": 7
}
```

#### Common Request Headers
```
Authorization: Bearer <token>
Content-Type: application/json
Accept: application/json
```

#### Common Error Responses
```
401 Unauthorized  — missing or invalid token
404 Not Found     — notification does not exist or does not belong to student
400 Bad Request   — invalid query parameters
500 Internal Server Error
```

#### Real-Time Notification Mechanism — Server-Sent Events (SSE)

SSE is chosen over WebSockets because notifications are server-to-client only (no bidirectional need), simpler to implement, and works over standard HTTP without protocol upgrades.

```
GET /api/notifications/stream
Authorization: Bearer <token>
Accept: text/event-stream

Server pushes:
data: {"id":"uuid","type":"Placement","message":"Google hiring","createdAt":"2026-04-22T18:00:00Z"}
```

The client reconnects automatically on disconnect. Each event carries the full notification payload so the client can append it to the local list without a separate fetch.

---

## Stage 2

### Persistent Storage — Database Choice and Schema

**Chosen DB: PostgreSQL**

Reasons:
- ACID compliance guarantees no partial writes during bulk notification inserts
- Native enum types for `notificationType`
- Partial indexes reduce index size for the common `isRead = false` query pattern
- Mature tooling (pg, Prisma, TypeORM) with strong TypeScript support
- Row-level security enables per-student access control at the DB layer

#### Schema

```sql
CREATE TYPE notification_type AS ENUM ('Event', 'Result', 'Placement');

CREATE TABLE students (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(100)  NOT NULL,
  email       VARCHAR(255)  NOT NULL UNIQUE,
  roll_no     VARCHAR(50)   NOT NULL UNIQUE,
  created_at  TIMESTAMP     NOT NULL DEFAULT NOW()
);

CREATE TABLE notifications (
  id                 UUID             PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id         INTEGER          NOT NULL REFERENCES students(id) ON DELETE CASCADE,
  notification_type  notification_type NOT NULL,
  message            TEXT             NOT NULL,
  is_read            BOOLEAN          NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMP        NOT NULL DEFAULT NOW()
);

-- Composite index covering the most frequent access pattern
CREATE INDEX idx_notif_student_unread
  ON notifications(student_id, is_read, created_at DESC)
  WHERE is_read = FALSE;

-- Index for type-based filtering
CREATE INDEX idx_notif_type_created
  ON notifications(notification_type, created_at DESC);
```

#### Problems as Data Volume Increases

1. **Table bloat** — with 50k students and millions of notifications, sequential scans on unindexed columns become slow.
2. **Write amplification** — every INSERT must update all indexes; high-frequency bulk inserts (notify_all) create write contention.
3. **Index bloat** — partial index on `is_read = false` shrinks as notifications are read, but old dead tuples need vacuuming.
4. **ORDER BY on large result sets** — even with an index, fetching all unread for an active student is expensive without a `LIMIT`.

#### Solutions at Scale

- **Partition** `notifications` by `created_at` (range partitioning by month) so queries only scan the relevant partition.
- **Archive** notifications older than 6 months to a cold table or object storage.
- **Read replicas** — route all SELECT queries to a replica; writes go to primary.
- **Connection pooling** via PgBouncer to avoid exhausting connection limits under heavy load.

#### SQL Queries Based on Stage 1 APIs

```sql
-- GET /api/notifications (paginated, unread only)
SELECT id, notification_type, message, is_read, created_at
FROM notifications
WHERE student_id = $1
  AND ($2::boolean IS NULL OR is_read = $2)
  AND ($3::notification_type IS NULL OR notification_type = $3)
ORDER BY created_at DESC
LIMIT $4 OFFSET $5;

-- GET /api/notifications/unread-count
SELECT COUNT(*) AS count
FROM notifications
WHERE student_id = $1 AND is_read = FALSE;

-- PATCH /api/notifications/:id/read
UPDATE notifications
SET is_read = TRUE
WHERE id = $1 AND student_id = $2;

-- PATCH /api/notifications/read-all
UPDATE notifications
SET is_read = TRUE
WHERE student_id = $1 AND is_read = FALSE;
```

---

## Stage 3

### Query Analysis and Optimisation

#### Original Query

```sql
SELECT * FROM notifications WHERE studentID = 1042 AND isRead = false ORDER BY createdAt DESC
```

**Is the query accurate?**
Yes — it correctly retrieves all unread notifications for student 1042 ordered by most recent first. The logic is right for the use case.

**Why is it slow?**

1. `SELECT *` fetches every column including large TEXT fields and unused metadata, increasing I/O.
2. Without a composite index on `(studentID, isRead, createdAt)`, PostgreSQL performs a sequential scan of the entire `notifications` table.
3. The `ORDER BY createdAt DESC` requires an in-memory sort unless the index already provides the order.

**What to change**

```sql
SELECT id, student_id, notification_type, message, created_at
FROM notifications
WHERE student_id = 1042
  AND is_read = FALSE
ORDER BY created_at DESC;
```

Add a partial composite index (only indexes rows where `is_read = FALSE`, which is the minority — keeps the index small):

```sql
CREATE INDEX idx_notif_student_unread
  ON notifications(student_id, is_read, created_at DESC)
  WHERE is_read = FALSE;
```

With this index, PostgreSQL performs an index scan instead of a full table scan. No separate sort step is needed because the index already orders by `created_at DESC`.

**Estimated cost improvement:** from O(N) full table scan to O(log N + k) index scan where k is the number of unread notifications for that student.

**"Add indexes on every column" — Is this advice good?**

No. It is harmful:
- Every additional index slows down INSERT, UPDATE, and DELETE because the engine must maintain all indexes on write.
- For a table receiving 50k inserts in a single `notify_all` call, unnecessary indexes create significant write amplification.
- The query optimiser may choose a suboptimal index if too many exist.
- Indexes consume disk space and memory (shared_buffers).

The correct approach is to index only the columns that appear in `WHERE`, `JOIN`, and `ORDER BY` clauses of frequent, slow queries.

#### Query — Students Who Received a Placement Notification in the Last 7 Days

```sql
SELECT DISTINCT student_id
FROM notifications
WHERE notification_type = 'Placement'
  AND created_at >= NOW() - INTERVAL '7 days';
```

Supporting index:
```sql
CREATE INDEX idx_notif_type_created
  ON notifications(notification_type, created_at DESC);
```

---

## Stage 4

### Performance — Reducing DB Load on Page Load

**Problem:** Every student page load fires a DB query. At 50k active students, this creates sustained high read load that overwhelms the database.

#### Solution 1 — Application-Level Cache (Redis)

Cache each student's notification list with a short TTL (30–60 seconds). On a new notification, invalidate that student's cache key.

```
GET /api/notifications → check Redis → HIT: return cached → MISS: query DB, cache result, return
New notification arrives → DEL notifications:student:<id>
```

**Trade-offs:**
- Pro: Dramatic reduction in DB reads; sub-millisecond cache hits.
- Con: Up to TTL seconds of staleness. Acceptable for a notification feed; not acceptable for financial data.

#### Solution 2 — Pagination

Never return all notifications at once. Return 20 per page. This caps the query cost regardless of how many notifications exist.

**Trade-offs:**
- Pro: Predictable, bounded query cost.
- Con: Requires client-side pagination controls.

#### Solution 3 — Read Replica

Route all SELECT queries to a PostgreSQL read replica. The primary only handles writes.

**Trade-offs:**
- Pro: Scales read throughput horizontally; primary write performance improves.
- Con: Replication lag (typically < 100ms) means a student may not see a just-sent notification immediately.

#### Solution 4 — Connection Pooling (PgBouncer)

At 50k concurrent users each holding a DB connection, PostgreSQL runs out of connections. PgBouncer multiplexes many application connections over a small pool of actual DB connections.

**Trade-offs:**
- Pro: Prevents connection exhaustion with minimal latency overhead.
- Con: Does not reduce query volume; must be combined with caching.

**Recommended combination:** Redis caching (primary relief) + pagination (bounding query size) + connection pooling (connection management).

---

## Stage 5

### Reliability — Redesigning notify_all

#### Original Implementation

```
function notify_all(student_ids: array, message: string):
    for student_id in student_ids:
        send_email(student_id, message)
        save_to_db(student_id, message)
        push_to_app(student_id, message)
```

#### Shortcomings

1. **Sequential loop** — 50k iterations over a network call per iteration. At 200ms per email API call, this takes ~2.8 hours. Unacceptable.
2. **No error isolation** — if `send_email` fails at student 200, students 201–50000 receive no email and no notification. The function likely throws and aborts.
3. **No retry** — a transient email API failure is permanent with this design.
4. **Save order is wrong** — if `save_to_db` follows `send_email`, some students get an email but have no notification record in the DB (if DB fails after email succeeds).
5. **Tight coupling** — email, DB, and push are a single synchronous unit. Any one failure blocks all others.

#### Should DB save and email happen together?

No. They must be decoupled:
- The DB is the source of truth. Save to DB **first**. If email later fails, the notification still exists and can be retried.
- Email is a side effect. Sending the same email twice is far less harmful than missing it entirely — so it should be retried independently.
- Transactional guarantees cannot span a DB write and an external email API call. Trying to couple them creates partial-failure states that are hard to reason about.

#### Redesigned Approach

1. Batch-insert all notifications into DB in a single query.
2. Enqueue one job per student into a message queue (Redis Queue, RabbitMQ, or SQS) for email and push separately.
3. Workers consume the queue, call the email API with retry and exponential backoff, and mark each job done.
4. An idempotency key (the notification ID) prevents duplicate emails on retry.

#### Revised Pseudocode

```
function notify_all(student_ids: array, message: string):
    // Single batch insert — O(1) round trips to DB
    notification_ids = batch_save_to_db(student_ids, message)

    // Enqueue async jobs — non-blocking
    for i, student_id in enumerate(student_ids):
        email_queue.enqueue({
            notification_id: notification_ids[i],
            student_id: student_id,
            message: message
        })
        push_queue.enqueue({
            notification_id: notification_ids[i],
            student_id: student_id,
            message: message
        })

// Email worker (runs independently, horizontally scalable):
function process_email_job(job):
    if email_already_sent(job.notification_id):
        return  // idempotency guard — safe to skip on retry
    try:
        send_email(job.student_id, job.message)
        mark_email_sent(job.notification_id)
    except TransientError:
        queue.requeue(job, delay=exponential_backoff(job.attempt))
    except PermanentError:
        log_failed(job)  // alert on-call; do not requeue

// Push worker (runs independently):
function process_push_job(job):
    push_to_app(job.student_id, job.message)
```

**Why is this fast?** Batch DB insert is one query. Enqueueing 50k jobs is fast (Redis: ~100k ops/sec). Workers run in parallel across multiple processes.

**What now (200 failed mid-way)?** With the original design, students 201–50000 got nothing. With the queue design, every job is independently retried. The 200 failed jobs requeue and succeed on retry. Students 201–50000 are unaffected.

---

## Stage 6

### Priority Inbox — Approach

Notifications are ranked by a weighted combination of **type importance** and **recency**.

**Type weights:** Placement = 3, Result = 2, Event = 1

**Scoring formula:**

```
normalizedWeight  = (typeWeight - 1) / 2          // maps {1,2,3} → {0, 0.5, 1}
normalizedRecency = (ts - minTs) / (maxTs - minTs) // maps timestamps → [0, 1]
priorityScore     = 0.6 × normalizedWeight + 0.4 × normalizedRecency
```

Type accounts for 60% of the score; recency for 40%. This ensures a recent Placement always outranks an older Event, while within the same type, more recent notifications surface first.

**Maintaining top 10 efficiently as new notifications arrive:**

Use a min-heap of size N. When a new notification arrives:
- Compute its priority score.
- If the heap has fewer than N items, push it.
- If the score is higher than the heap minimum, pop the minimum and push the new notification.
- This keeps the heap at size N with O(log N) per insertion — far cheaper than re-sorting the entire list.

The implementation (in `notification_app_be/src/index.ts`) fetches notifications from the evaluation service API, computes priority scores, sorts descending, and returns the top N. The top N value is configurable via a command-line argument (default: 10).
