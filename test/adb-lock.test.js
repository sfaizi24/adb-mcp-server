import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { AdbLock } from "../index.js";

test("queues tasks in order: second waits for first", async () => {
  const lock = new AdbLock();
  const order = [];

  // First task: slow (50ms delay before pushing).
  const first = lock.acquire(async () => {
    await delay(50);
    order.push("first");
    return "first-result";
  });

  // Second task: fast — would finish in 5ms if it ran in parallel, but it
  // must wait for the first to complete.
  const second = lock.acquire(async () => {
    await delay(5);
    order.push("second");
    return "second-result";
  });

  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(r1, "first-result");
  assert.equal(r2, "second-result");
  assert.deepEqual(order, ["first", "second"]);
});

test("queue keeps running after a failing task", async () => {
  const lock = new AdbLock();
  const order = [];

  const first = lock.acquire(async () => {
    await delay(10);
    order.push("first-failed");
    throw new Error("boom");
  });

  const second = lock.acquire(async () => {
    order.push("second-ran");
    return 42;
  });

  await assert.rejects(first, /boom/);
  const r2 = await second;
  assert.equal(r2, 42);
  assert.deepEqual(order, ["first-failed", "second-ran"]);
});

test("multiple queued tasks all execute in submission order", async () => {
  const lock = new AdbLock();
  const order = [];

  const tasks = [];
  for (let i = 0; i < 5; i++) {
    // Earlier tasks sleep longer — if they ran in parallel, order would be reversed.
    const sleep = (5 - i) * 10;
    tasks.push(
      lock.acquire(async () => {
        await delay(sleep);
        order.push(i);
        return i;
      })
    );
  }

  const results = await Promise.all(tasks);
  assert.deepEqual(results, [0, 1, 2, 3, 4]);
  assert.deepEqual(order, [0, 1, 2, 3, 4]);
});
