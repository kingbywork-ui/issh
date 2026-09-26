import assert from 'node:assert/strict'
import { insertSplitPane, layoutLeaves, removeSplitPane } from '../src/lib/splitLayout.ts'

let layout = insertSplitPane(null, 'main', 'right', 'vertical')
layout = insertSplitPane(layout, 'right', 'below-right', 'horizontal')
assert.equal(layout.orientation, 'vertical')
assert.equal(layout.children[1].orientation, 'horizontal')
assert.deepEqual(layoutLeaves(layout), ['main', 'right', 'below-right'])

layout = insertSplitPane(layout, 'main', 'below-left', 'horizontal')
assert.equal(layout.children[0].orientation, 'horizontal')
assert.deepEqual(layoutLeaves(layout), ['main', 'below-left', 'right', 'below-right'])

layout = removeSplitPane(layout, 'right')
assert.deepEqual(layoutLeaves(layout), ['main', 'below-left', 'below-right'])
assert.equal(layout.children[1].type, 'pane')
layout = removeSplitPane(layout, 'below-right')
assert.equal(layout.orientation, 'horizontal')
assert.deepEqual(layoutLeaves(layout), ['main', 'below-left'])

console.log('split layout: mixed directions, nested insertion and pane removal passed')
