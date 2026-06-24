import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const app = express()

const PORT = Number(process.env.PORT || 3000)
const PASSWORD = process.env.APP_PASSWORD || '0505'
const DATA_ROOT = process.env.DATA_ROOT
  ? path.resolve(process.env.DATA_ROOT)
  : path.join(__dirname, 'data')
const DATA_DIR = DATA_ROOT
const DATA_FILE = path.join(DATA_DIR, 'inventory.shared.json')
const REPO_SHARED_FILE = path.join(__dirname, 'data', 'inventory.shared.json')
const SEED_FILE = path.join(__dirname, 'src', 'data', 'inventory.json')
const DIST_DIR = path.join(__dirname, 'dist')
const sessions = new Map()

app.use(express.json({ limit: '1mb' }))

function normalize(value = '') {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function ensureStatus(value) {
  return value === 'staging' ? 'staging' : 'active'
}

function sanitizeList(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(value.map((entry) => normalize(entry)).filter(Boolean))]
}

function buildTags(item) {
  return [
    ...new Set(
      [
        item.status === 'staging' ? '暫存區' : item.area.replace('家裡-', ''),
        item.parentLabel,
        item.childLabel,
      ].filter(Boolean),
    ),
  ]
}

function createSearchText(item) {
  return [
    item.area,
    item.location,
    item.parentLabel,
    item.childLabel,
    item.reason,
    item.name,
    item.stagingNote,
    item.llmSuggestion,
    item.status,
    ...item.aliases,
    ...item.tags,
  ]
    .filter(Boolean)
    .join(' ')
}

function normalizeExistingItem(input = {}) {
  const now = new Date().toISOString()
  const item = {
    id: normalize(input.id) || `item-${crypto.randomUUID()}`,
    name: normalize(input.name),
    area: normalize(input.area),
    location: normalize(input.location),
    parentLabel: normalize(input.parentLabel),
    childLabel: normalize(input.childLabel),
    reason: normalize(input.reason),
    aliases: sanitizeList(input.aliases),
    tags: sanitizeList(input.tags),
    status: ensureStatus(input.status),
    stagingNote: normalize(input.stagingNote),
    llmSuggestion: normalize(input.llmSuggestion),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || input.createdAt || now,
  }

  item.tags = item.tags.length > 0 ? item.tags : buildTags(item)
  item.searchText = createSearchText(item)
  return item
}

function toItem(input, existingItem) {
  const now = new Date().toISOString()
  const item = {
    id: existingItem?.id || `item-${crypto.randomUUID()}`,
    name: normalize(input.name),
    area: normalize(input.area),
    location: normalize(input.location),
    parentLabel: normalize(input.parentLabel),
    childLabel: normalize(input.childLabel),
    reason: normalize(input.reason),
    aliases: sanitizeList(input.aliases),
    tags: sanitizeList(input.tags),
    status: ensureStatus(input.status || existingItem?.status),
    stagingNote: normalize(input.stagingNote),
    llmSuggestion: normalize(input.llmSuggestion),
    createdAt: existingItem?.createdAt || now,
    updatedAt: now,
  }

  item.tags = item.tags.length > 0 ? item.tags : buildTags(item)
  item.searchText = createSearchText(item)
  return item
}

async function ensureDataFile() {
  await fs.mkdir(DATA_DIR, { recursive: true })

  try {
    await fs.access(DATA_FILE)
  } catch {
    let seedSource = SEED_FILE

    try {
      await fs.access(REPO_SHARED_FILE)
      seedSource = REPO_SHARED_FILE
    } catch {
      seedSource = SEED_FILE
    }

    const seed = await fs.readFile(seedSource, 'utf8')
    const items = JSON.parse(seed).map((item) => normalizeExistingItem(item))
    await fs.writeFile(DATA_FILE, `${JSON.stringify(items, null, 2)}\n`)
  }
}

async function readItems() {
  await ensureDataFile()
  const raw = await fs.readFile(DATA_FILE, 'utf8')
  return JSON.parse(raw).map((item) => normalizeExistingItem(item))
}

async function writeItems(items) {
  await ensureDataFile()
  const normalizedItems = items.map((item) => normalizeExistingItem(item))
  await fs.writeFile(DATA_FILE, `${JSON.stringify(normalizedItems, null, 2)}\n`)
}

function getTokenFromRequest(request) {
  const authHeader = request.headers.authorization || ''

  if (!authHeader.startsWith('Bearer ')) {
    return null
  }

  return authHeader.slice('Bearer '.length)
}

function requireAuth(request, response, next) {
  const token = getTokenFromRequest(request)

  if (!token || !sessions.has(token)) {
    response.status(401).json({ message: '尚未登入或登入已失效。' })
    return
  }

  next()
}

function validateItem(item) {
  if (!item.name) {
    return '至少需要物品名稱。'
  }

  if (item.status === 'active' && (!item.area || !item.location || !item.parentLabel || !item.childLabel)) {
    return '正式歸檔至少需要區域、位置、大類與子類。'
  }

  return null
}

function buildReviewPrompt(items) {
  const activeItems = items.filter((item) => item.status === 'active')
  const stagingItems = items.filter((item) => item.status === 'staging')
  const areaSet = new Set(activeItems.map((item) => item.area).filter(Boolean))
  const locationSet = new Set(activeItems.map((item) => item.location).filter(Boolean))

  const grouped = new Map()
  for (const item of activeItems) {
    const key = [item.area, item.location, item.parentLabel, item.childLabel].join(' | ')
    if (!grouped.has(key)) {
      grouped.set(key, {
        area: item.area,
        location: item.location,
        parentLabel: item.parentLabel,
        childLabel: item.childLabel,
        reason: item.reason,
        items: [],
      })
    }
    grouped.get(key).items.push(item.name)
  }

  const structureLines = [...grouped.values()]
    .sort((left, right) => {
      const leftKey = [left.area, left.location, left.parentLabel, left.childLabel].join(' ')
      const rightKey = [right.area, right.location, right.parentLabel, right.childLabel].join(' ')
      return leftKey.localeCompare(rightKey, 'zh-Hant')
    })
    .map((entry, index) => {
      const itemList = entry.items.join('、')
      const reasonLine = entry.reason ? `；放置理由：${entry.reason}` : ''
      return `${index + 1}. ${entry.area} > ${entry.location} > ${entry.parentLabel} > ${entry.childLabel}；物品：${itemList}${reasonLine}`
    })
    .join('\n')

  const stagingLines = stagingItems.length
    ? stagingItems
        .map((item, index) => {
          const candidate = [item.area, item.location, item.parentLabel, item.childLabel].filter(Boolean).join(' > ') || '尚未指定'
          return `${index + 1}. 名稱：${item.name}\n   暫存說明：${item.stagingNote || '未填寫'}\n   目前候選位置：${candidate}\n   背景備註：${item.reason || '未填寫'}\n   既有 LLM 建議：${item.llmSuggestion || '無'}`
        })
        .join('\n')
    : '目前暫存區為空。'

  const prompt = [
    '你是一位擅長空間收納系統、維修工具分類、家庭動線規劃與資料審計的高階顧問。',
    '請根據下面的「現行收納結構」與「暫存區物品」，完成整體評分與歸位建議。',
    '',
    '請完成以下任務：',
    '1. 先從整體角度評分目前收納系統，分別給出 1-10 分：搜尋性、動線合理性、類別一致性、維護成本、擴充性。',
    '2. 說明目前結構的優點、重複分類風險、容易混淆的位置、可再整併或拆分的區塊。',
    '3. 針對每一件暫存區物品，給出建議的區域、位置、Parent、Child、放置理由。',
    '4. 如果某件物品不適合立即歸檔，請明確說明應維持暫存的理由。',
    '5. 若有比現有結構更好的分類法，也請提出。',
    '',
    '請盡量用繁體中文，並用下列格式回覆：',
    'A. 總評',
    'B. 五項評分表',
    'C. 結構問題與優點',
    'D. 暫存物品逐件建議',
    'E. 若要讓 IDE 協助自動歸檔，請額外提供 JSON 陣列，格式如下：',
    '[',
    '  {',
    '    "name": "物品名稱",',
    '    "status": "active 或 staging",',
    '    "area": "建議區域",',
    '    "location": "建議位置",',
    '    "parentLabel": "建議 Parent",',
    '    "childLabel": "建議 Child",',
    '    "reason": "簡短原因",',
    '    "llmSuggestion": "可直接貼回系統的摘要"',
    '  }',
    ']',
    '',
    `目前正式收納物品數：${activeItems.length}`,
    `目前暫存區物品數：${stagingItems.length}`,
    `正式收納區域數：${areaSet.size}`,
    `正式收納位置數：${locationSet.size}`,
    '',
    '【現行收納結構】',
    structureLines,
    '',
    '【暫存區物品】',
    stagingLines,
  ].join('\n')

  return {
    prompt,
    summary: {
      activeCount: activeItems.length,
      stagingCount: stagingItems.length,
      areas: areaSet.size,
      locations: locationSet.size,
    },
  }
}

app.get('/api/health', (_request, response) => {
  response.json({ ok: true })
})

app.post('/api/login', (request, response) => {
  if (normalize(request.body?.password) !== PASSWORD) {
    response.status(401).json({ message: '密碼錯誤。' })
    return
  }

  const token = crypto.randomBytes(24).toString('hex')
  sessions.set(token, { createdAt: Date.now() })
  response.json({ token })
})

app.get('/api/session', requireAuth, (_request, response) => {
  response.json({ ok: true })
})

app.get('/api/items', async (_request, response) => {
  try {
    const items = await readItems()
    const stats = await fs.stat(DATA_FILE)
    response.json({
      items,
      updatedAt: stats.mtime.toISOString(),
    })
  } catch (error) {
    response.status(500).json({
      message: '讀取資料失敗。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.get('/api/export/review-prompt', async (_request, response) => {
  try {
    const items = await readItems()
    response.json(buildReviewPrompt(items))
  } catch (error) {
    response.status(500).json({
      message: '產生覆核提示詞失敗。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.post('/api/items', requireAuth, async (request, response) => {
  try {
    const items = await readItems()
    const item = toItem(request.body ?? {})
    const validationError = validateItem(item)

    if (validationError) {
      response.status(400).json({ message: validationError })
      return
    }

    items.unshift(item)
    await writeItems(items)
    response.status(201).json({ item })
  } catch (error) {
    response.status(500).json({
      message: '新增資料失敗。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.put('/api/items/:id', requireAuth, async (request, response) => {
  try {
    const items = await readItems()
    const index = items.findIndex((item) => item.id === request.params.id)

    if (index === -1) {
      response.status(404).json({ message: '找不到指定物品。' })
      return
    }

    const updatedItem = toItem(request.body ?? {}, items[index])
    const validationError = validateItem(updatedItem)

    if (validationError) {
      response.status(400).json({ message: validationError })
      return
    }

    items[index] = updatedItem
    await writeItems(items)
    response.json({ item: updatedItem })
  } catch (error) {
    response.status(500).json({
      message: '更新資料失敗。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.delete('/api/items/:id', requireAuth, async (request, response) => {
  try {
    const items = await readItems()
    const nextItems = items.filter((item) => item.id !== request.params.id)

    if (nextItems.length === items.length) {
      response.status(404).json({ message: '找不到指定物品。' })
      return
    }

    await writeItems(nextItems)
    response.status(204).end()
  } catch (error) {
    response.status(500).json({
      message: '刪除資料失敗。',
      detail: error instanceof Error ? error.message : String(error),
    })
  }
})

app.use(express.static(DIST_DIR))

app.get(/^(?!\/api).*/, (_request, response) => {
  response.sendFile(path.join(DIST_DIR, 'index.html'))
})

await ensureDataFile()

app.listen(PORT, () => {
  console.log(`Storage organizer server is running at http://localhost:${PORT}`)
  console.log(`Using shared inventory file: ${DATA_FILE}`)
})
