# ecs-rds-postgres-pool — results

Each row is one `/loadtest` run: the k6 profile, the one infra change that distinguishes it from the
previous row, and the SLO/pool/instance numbers that run produced. `posts rows` is
`SELECT count(*) FROM posts`, taken immediately before the run starts — the table is never reset
between runs (20% of the mix inserts, and a heartbeat inserts one row a minute), so its size is
recorded rather than controlled.

| date       | profile                            | infra change                                                                                                                                                                                                                                        | RPS                                                                                                                                 | k6 attainment | service attainment | budget burn x | p95 fast/std/heavy  | db ms                     | DBLoadCPU/vCPU | connections           | pool size | posts rows                    | disk MB/s peak min (r+w) | disk queue max |
|------------|------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------------------------------------------|---------------|--------------------|---------------|---------------------|---------------------------|----------------|-----------------------|-----------|-------------------------------|--------------------------|----------------|
| 2026-11-04 | discovery (run 8950516, 14:11 UTC) | baseline for the instance-size series: db.t4g.micro (1 GiB), RDS Proxy on, pool 40 x 1 task                                                                                                                                                         | 79 peak minute (ALB); knee at step 200 (rps_100 0.990, rps_200 0.805)                                                               | 93.4%         | 90.9%              | 1.8           | 0.096/0.058/9.9 s   | 173 (fast 32, heavy 3069) | 0.45           | 42                    | 40x1      | n/a                           | 105 (r63 w42)            | 36.7           |
| 2026-11-04 | discovery (run 8950832, 15:07 UTC) | db.t4g.micro -> db.t4g.small (2 GiB), nothing else; run ended by "Mimir active series limit exceeded", not by the SLO abort                                                                                                                         | 167 peak minute (ALB); knee at step 300 (rps_200 0.991, rps_300 0.857)                                                              | 95.4%         | 93.0%              | 1.4           | 0.075/0.022/5.5 s   | 92 (fast 21, heavy 1511)  | 0.44           | 42                    | 40x1      | ~58,289                       | 129 (r1 w128)            | 42.0           |
| 2026-11-04 | discovery (run 8951051, 15:44 UTC) | pool_size 40 -> 120 on db.t4g.small, one task, proxy on; nothing else; run ended by "Mimir active series limit exceeded", not by the SLO abort                                                                                                      | 186 peak minute (ALB); knee at step 300 (rps_200 0.985, rps_300 0.884)                                                              | 95.5%         | 95.7%              | 0.9           | 0.044/0.015/5.4 s   | 79 (fast 10, heavy 1459)  | 0.35           | 42 (66 after the run) | 120x1     | ~63,855                       | 97 (r0 w97)              | 28.7           |
| 2026-11-04 | discovery (run 8951259, 16:20 UTC) | pool_size 120 -> 85 and desired_count 1 -> 2 (170 pool slots in total) on db.t4g.small, proxy on; run ended by "Mimir active series limit exceeded", not by the SLO abort                                                                           | 179 peak minute (ALB); knee at step 300 (rps_200 0.985, rps_300 0.886)                                                              | 95.9%         | 96.2%              | 0.8           | 0.038/0.013/5.5 s   | 86 (fast 9, heavy 1574)   | 0.32           | 69                    | 85x2      | ~69,271                       | 131 (r6 w126)            | 41.7           |
| 2026-11-04 | discovery (run 8951436, 16:54 UTC) | db.t4g.small -> db.t4g.medium (4 GiB, 2 vCPUs), nothing else (pool 85 x 2 tasks, proxy on, same task definition, query unchanged); run ended by "Mimir active series limit exceeded", not by the SLO abort                                          | 235 peak minute (ALB); knee at step 300 (rps_200 0.995, rps_300 0.917)                                                              | 97.0%         | 97.2%              | 0.6           | 0.026/0.014/2.0 s   | 32 (fast 9, heavy 483)    | 0.70           | 41                    | 85x2      | ~74,649                       | 52 (r0 w52)              | 11.9           |
| 2026-11-04 | discovery (run 8951616, 17:26 UTC) | db.t4g.medium -> db.m7g.xlarge (4 vCPUs, 16 GiB, not burstable), nothing else (pool 85 x 2 tasks, proxy on, same task definition, query unchanged); run ended by "Mimir active series limit exceeded" in step 300, before any breach                | 270 peak minute (ALB); no breach: last clean step 300 (rps_100 0.998, rps_200 0.996, rps_300 0.996), knee not found                 | 99.6%         | 99.9%              | 0.02          | 0.007/0.007/0.088 s | 8 (fast 4, heavy 84)      | 0.09           | 12                    | 85x2      | ~80,823                       | 5 (r1 w4)                | 0.1            |
| 2026-11-04 | discovery (run 8951737, 17:57 UTC) | same db.m7g.xlarge and pool 85 x 2 tasks; k6 profile only: lib/request.js now sets a name tag on /posts/:id and /feeds/:id/posts, steps 300 to 900 (7 steps); the run was not cut off by the Mimir limit and ended by the slo_met abort in step 900 | 765 peak minute (ALB); knee at step 500 (rps_300 0.984, rps_400 0.980, rps_500 0.9499, rps_600 0.962, rps_700 0.943, rps_800 0.903) | 94.6%         | 97.4%              | 0.5           | 0.025/0.023/0.195 s | 14 (fast 9, heavy 106)    | 0.39           | 105                   | 85x2      | n/a (not read before the run) | 31 (r0 w31)              | 11.8           |

## Summary

Seven `discovery` runs on 2026-11-04. Peak RPS is the busiest minute at the load balancer. Run 6 stopped inside step 300, so its bar is a floor.

```
Peak requests per second
 1 t4g.micro    pool 40x1   ████                                        79
 2 t4g.small    pool 40x1   █████████                                  167
 3 t4g.small    pool 120x1  ██████████                                 186
 4 t4g.small    pool 85x2   █████████                                  179
 5 t4g.medium   pool 85x2   ████████████                               235
 6 m7g.xlarge   pool 85x2   ██████████████ (cut short)                >270
 7 m7g.xlarge   pool 85x2   ████████████████████████████████████████   765

Disk MB/s in the busiest minute (read plus write). The gp3 volume cap is about 131.
 1 t4g.micro                █████████████████████                      105
 2 t4g.small                ██████████████████████████                 129
 3 t4g.small                ███████████████████                         97
 4 t4g.small                ██████████████████████████                 131
 5 t4g.medium               ██████████                                  52
 6 m7g.xlarge               █                                            5
 7 m7g.xlarge               ██████                                      31
```

- Peak RPS rose from 79 to 765. Heavy route p95 fell from 9.9 s to 0.195 s. Service SLO attainment rose from 90.9% to 97.4%.
- Runs 1 to 4 (micro and small) stopped on the disk. The heavy `report` query sorts 25,000 rows including the 1 KB `body` column, and `work_mem` is 4 MB, so each call wrote a 23 MB temp file. Disk throughput reached 97 to 131 MB/s, the volume cap, with queue depth 29 to 42.
- A bigger pool (40 to 120) and a second task did not move the knee on the small instance. The pool never queued.
- Medium (4 GiB) took the load off the disk (52 MB/s). The database CPU rose to 79%.
- On `db.m7g.xlarge` (4 vCPUs, 16 GiB) the first run (6) was cut off inside step 300 with nothing saturated. The full run (7, steps 300 to 900) found the knee at step 500.

## Report

- **Result.** `db.m7g.xlarge`, pool 85 x 2 tasks, run 8951737: last clean step 400, first breached step 500, peak 765 requests per second, service attainment 97.4%, no 5xx responses. The knee is marginal (step 500 scored 0.9499, step 600 passed, steps 700 and 800 breached), so read it as between 500 and 700.
- **What limits it.** The app tier first (service CPU 79% at the knee, 93 to 96% at 765 requests per second), then the database CPU (59% to 94%). The disk is no longer involved (31 MB/s).
