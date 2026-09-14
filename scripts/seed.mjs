import pg from 'pg'
import mariadb from 'mariadb'
import { createClient } from 'redis'
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
const postgres = new pg.Client({
  host: '127.0.0.1',
  port: 15432,
  user: 'harbor',
  password: 'harbor_test',
  database: 'harbor',
})
const maria = await mariadb.createConnection({
  host: '127.0.0.1',
  port: 13306,
  user: 'harbor',
  password: 'harbor_test',
  database: 'harbor',
})
const redis = createClient({ url: 'redis://:harbor_test@127.0.0.1:16379' })
await postgres.connect()
await redis.connect()
try {
  await postgres.query(
    'CREATE TABLE IF NOT EXISTS customers (id bigint PRIMARY KEY, name text NOT NULL, email text, created_at timestamptz DEFAULT now()); CREATE TABLE IF NOT EXISTS orders (id bigint PRIMARY KEY, customer_id bigint REFERENCES customers(id), status text, total numeric(30,8), created_at timestamptz DEFAULT now(), metadata jsonb); CREATE TABLE IF NOT EXISTS products (id bigint PRIMARY KEY,name text,price numeric(30,8)); CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders(customer_id)',
  )
  await maria.query(
    'CREATE TABLE IF NOT EXISTS customers (id BIGINT PRIMARY KEY, name VARCHAR(100) NOT NULL, email VARCHAR(200), created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB',
  )
  await maria.query(
    'CREATE TABLE IF NOT EXISTS orders (id BIGINT PRIMARY KEY, customer_id BIGINT, status VARCHAR(30), total DECIMAL(30,8), created_at DATETIME(6) DEFAULT CURRENT_TIMESTAMP(6), metadata JSON, FOREIGN KEY(customer_id) REFERENCES customers(id)) ENGINE=InnoDB',
  )
  await maria.query(
    'CREATE TABLE IF NOT EXISTS products (id BIGINT PRIMARY KEY,name VARCHAR(100),price DECIMAL(30,8)) ENGINE=InnoDB',
  )
  for (let i = 0; i < names.length; i++) {
    await postgres.query('INSERT INTO customers(id,name,email) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING', [
      i + 1,
      names[i],
      `${names[i].split(' ')[0].toLowerCase()}@example.test`,
    ])
    await maria.query('INSERT IGNORE INTO customers(id,name,email) VALUES(?,?,?)', [
      i + 1,
      names[i],
      `${names[i].split(' ')[0].toLowerCase()}@example.test`,
    ])
  }
  await postgres.query(
    "INSERT INTO orders SELECT g, (g%12)+1, CASE WHEN g%3=0 THEN 'processing' ELSE 'delivered' END, (g%10000)::numeric/100, now() - (g || ' seconds')::interval, '{\"source\":\"local test fixture\",\"large\":9007199254740993}'::jsonb FROM generate_series(1,100000) g ON CONFLICT DO NOTHING",
  )
  const [{ n }] = await maria.query('SELECT COUNT(*) AS n FROM orders')
  if (Number(n) < 100000) {
    for (let batch = 0; batch < 100; batch++) {
      const rows = Array.from({ length: 1000 }, (_, j) => {
        const i = batch * 1000 + j + 1
        return [
          i,
          (i % 12) + 1,
          i % 3 === 0 ? 'processing' : 'delivered',
          `${i % 10000}.12345678`,
          '{"source":"local test fixture","large":9007199254740993}',
        ]
      })
      await maria.batch(
        'INSERT IGNORE INTO orders(id,customer_id,status,total,metadata) VALUES(?,?,?,?,?)',
        rows,
      )
    }
  }
  await redis.set('harbor:welcome', '{"message":"Welcome to Harbor DB","exact_integer":9007199254740993}')
  await redis.set('harbor:session:demo', 'Session example', { EX: 3600 })
  await redis.hSet('harbor:user:1', { name: 'Olivia Carter', email: 'olivia@example.test' })
  await redis.del(['harbor:queue', 'harbor:tags', 'harbor:leaderboard', 'harbor:events'])
  await redis.rPush('harbor:queue', ['order:1', 'order:2', 'order:3'])
  await redis.sAdd('harbor:tags', ['development', 'database', 'local'])
  await redis.zAdd('harbor:leaderboard', [
    { score: 42, value: 'Olivia' },
    { score: 37, value: 'Liam' },
  ])
  await redis.xAdd('harbor:events', '*', { event: 'seeded', scope: 'local test' })
  for (let batch = 0; batch < 100; batch++) {
    const multi = redis.multi()
    for (let j = 0; j < 1000; j++) multi.set(`harbor:benchmark:${batch * 1000 + j}`, `value-${j}`)
    await multi.exec()
  }
  console.log(
    'Seeded PostgreSQL and MariaDB with 100,000 orders each; Redis with 100,000 benchmark keys and every supported type. Test data only, loopback ports 15432 / 13306 / 16379.',
  )
} finally {
  await postgres.end()
  await maria.end()
  await redis.quit()
}
