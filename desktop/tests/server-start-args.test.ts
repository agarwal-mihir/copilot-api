import { describe, expect, test } from 'bun:test'

import { buildServerStartArgs } from '../electron/server-start-args'

describe('desktop server arguments', () => {
  test('never puts credentials in process arguments', () => {
    expect(buildServerStartArgs(4141)).toEqual(['start', '--port', '4141'])
  })
})
