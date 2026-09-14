import type { Bootstrap, ObjectInfo, QueryResult } from '@shared/contracts'
import { profileSchema, settingsSchema } from '@shared/contracts'
export const demoProfiles = [
  profileSchema.parse({
    id: 'demo-postgres',
    name: 'Harbor sample',
    engine: 'postgres',
    host: 'demo.local',
    port: 5432,
    username: 'demo',
    database: 'harbor',
    environment: 'development',
    folder: 'Demo workspace',
    readOnly: true,
  }),
  profileSchema.parse({
    id: 'demo-mariadb',
    name: 'MariaDB sample',
    engine: 'mariadb',
    host: 'demo.local',
    port: 3306,
    username: 'demo',
    database: 'harbor',
    environment: 'development',
    folder: 'Demo workspace',
    readOnly: true,
  }),
  profileSchema.parse({
    id: 'demo-redis',
    name: 'Redis sample',
    engine: 'redis',
    host: 'demo.local',
    port: 6379,
    environment: 'development',
    folder: 'Demo workspace',
    readOnly: true,
  }),
]
export const demoSql =
  'SELECT o.id, c.name, o.status, o.total, o.created_at\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nORDER BY o.created_at DESC\nLIMIT 200;'
export const demoObjects: ObjectInfo[] = ['customers', 'orders', 'products', 'order_items', 'payments'].map(
  (name) => ({
    name,
    schema: 'public',
    kind: 'table',
    estimatedRows: name === 'orders' ? '100,000' : undefined,
  }),
)
const names = [
  'Olivia Carter',
  'Liam Nguyen',
  'Emma Wilson',
  'Noah Patel',
  'Ava Martinez',
  'William Kim',
  'Sophia Garcia',
  'James Anderson',
  'Isabella Thomas',
  'Benjamin Lee',
  'Mia Robinson',
  'Lucas White',
]
export const demoResult: QueryResult = {
  requestId: 'demo',
  durationMs: 0,
  messages: ['Example results for exploring the interface. Connect a database to execute queries.'],
  transaction: 'idle',
  sets: [
    {
      columns: [
        { name: 'id', type: 'integer', key: true },
        { name: 'name', type: 'text' },
        { name: 'status', type: 'text' },
        { name: 'total', type: 'numeric' },
        { name: 'created_at', type: 'timestamp' },
      ],
      rows: names.map((n, i) => [
        String(1058 - i),
        n,
        i % 3 === 1 ? 'processing' : 'delivered',
        [
          '129.50',
          '89.00',
          '240.00',
          '65.25',
          '312.00',
          '47.99',
          '199.00',
          '75.00',
          '160.50',
          '99.99',
          '280.00',
          '52.75',
        ][i],
        `2026-09-${String(14 - Math.floor(i / 3)).padStart(2, '0')} ${14 - (i % 4)}:32:18+00`,
      ]),
      affectedRows: 12,
      command: 'SELECT',
      truncated: false,
    },
  ],
}
export const previewBootstrap: Bootstrap = {
  profiles: [],
  workspace: { tabs: [], activeTabId: null, expanded: [], settings: settingsSchema.parse({}) },
  savedQueries: [],
  history: [],
  secureStorage: {
    available: false,
    backend: 'browser preview',
    reason: 'Secure storage is available in the desktop application.',
  },
  version: '0.1.0',
  platform: 'browser',
}
