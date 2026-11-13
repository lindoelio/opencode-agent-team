// Runs with the Node test runner and no install step:
//   node --test test/board.node-test.mjs
// Node strips the TypeScript types in ../src on the fly (Node 22.6+).
import test from "node:test";
import assert from "node:assert/strict";
import { addTask, archiveTask, createBoard, listTasks } from "../src/board.ts";

test("archives a task and filters Active/Archived", () => {
  const board = createBoard();
  const a = addTask(board, "Write spec");
  addTask(board, "Ship delivery");
  archiveTask(board, a.id);
  assert.deepEqual(listTasks(board, "active").map((t) => t.title), ["Ship delivery"]);
  assert.deepEqual(listTasks(board, "archived").map((t) => t.title), ["Write spec"]);
  assert.equal(listTasks(board, "all").length, 2);
});

test("a new task is active by default", () => {
  const board = createBoard();
  const task = addTask(board, "First");
  assert.equal(task.archived, false);
  assert.deepEqual(listTasks(board, "active").map((t) => t.id), [task.id]);
});

test("archiving an unknown task is refused", () => {
  const board = createBoard();
  assert.throws(() => archiveTask(board, "T-404"), /unknown task/);
});
