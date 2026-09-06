import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, classifyNodes, countDescendants, orphanGroups, findAccount } from '../js/thread.js';

let t = 0;
const st = (id, parent, acct, extra = {}) => ({
  id, in_reply_to_id: parent, account: { id: acct, acct },
  created_at: new Date(Date.UTC(2024, 0, 1, 0, 0, t++)).toISOString(), replies_count: 0, ...extra,
});

// OP thread 1 -> 2 -> 3 -> 5, with forks from bob and carol.
const fixture = () => {
  t = 0;
  return [
    st('1', null, 'op'),
    st('2', '1', 'op'),
    st('4', '2', 'bob'),
    st('3', '2', 'op'),
    st('5', '3', 'op'),
    st('6', '4', 'op'),   // op replies in a fork; not main line
    st('7', '4', 'carol'),
    st('8', '7', 'op'),
    st('9', '99', 'dave'), // orphan: parent missing
  ];
};

test('buildTree groups children sorted by time and counts orphans', () => {
  const tree = buildTree(fixture());
  assert.deepEqual(tree.children.get('2').map((s) => s.id), ['4', '3']);
  assert.deepEqual(tree.children.get('4').map((s) => s.id), ['6', '7']);
  assert.equal(tree.orphans, 1);
  assert.deepEqual(tree.roots.map((s) => s.id), ['1', '9']);
});

test('classifyNodes follows the root author self-reply chain', () => {
  const tree = buildTree(fixture());
  const main = classifyNodes(tree, '1', '1');
  assert.deepEqual([...main].sort(), ['1', '2', '3', '5']);
});

test('classifyNodes adds the path to a fork start status', () => {
  const tree = buildTree(fixture());
  const main = classifyNodes(tree, '1', '8');
  assert.deepEqual([...main].sort(), ['1', '2', '3', '4', '5', '7', '8']);
  assert.ok(!main.has('6'));
});

test('classifyNodes picks the earliest self-reply when the author forks their own thread', () => {
  t = 0;
  const list = [st('a', null, 'op'), st('b', 'a', 'op'), st('c', 'a', 'op'), st('d', 'c', 'op')];
  const tree = buildTree(list);
  const main = classifyNodes(tree, 'a', 'a');
  assert.deepEqual([...main].sort(), ['a', 'b']);
});

test('classifyNodes handles a root that is not the starting status author', () => {
  t = 0;
  const list = [st('a', null, 'x'), st('b', 'a', 'y'), st('c', 'b', 'x')];
  const tree = buildTree(list);
  const main = classifyNodes(tree, 'a', 'b');
  assert.deepEqual([...main].sort(), ['a', 'b']);
});

test('countDescendants counts the whole subtree', () => {
  const tree = buildTree(fixture());
  assert.equal(countDescendants(tree, '4'), 3);
  assert.equal(countDescendants(tree, '1'), 7);
  assert.equal(countDescendants(tree, '5'), 0);
});

test('orphanGroups groups replies by missing parent and skips the root', () => {
  t = 0;
  const list = [
    st('a', 'gone', 'x'),          // root whose own parent is missing
    st('b', 'a', 'y'),
    st('c', 'p1', 'y', { in_reply_to_account_id: 'x' }),
    st('d', 'c', 'z'),             // child of an orphan stays attached
    st('e', 'p1', 'z', { in_reply_to_account_id: 'x' }),
    st('f', 'p2', 'x'),
  ];
  const tree = buildTree(list);
  const groups = orphanGroups(tree, 'a');
  assert.deepEqual(groups.map((g) => [g.parentId, g.accountId, g.replies.map((r) => r.id)]), [['p1', 'x', ['c', 'e']], ['p2', null, ['f']]]);
  assert.deepEqual(tree.children.get('c').map((s) => s.id), ['d']);
  assert.equal(findAccount(tree, 'x').acct, 'x');
  assert.equal(findAccount(tree, 'nobody'), null);
  assert.equal(findAccount(tree, null), null);
});
