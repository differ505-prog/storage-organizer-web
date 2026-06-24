export type ItemStatus = 'active' | 'staging'

export type InventoryItem = {
  id: string
  name: string
  area: string
  location: string
  parentLabel: string
  childLabel: string
  reason: string
  aliases: string[]
  tags: string[]
  searchText: string
  status?: ItemStatus
  stagingNote?: string
  llmSuggestion?: string
  createdAt?: string
  updatedAt?: string
}

export type EnrichedItem = InventoryItem & {
  status: ItemStatus
  path: string
  normalizedSearchText: string
}

export type ReviewPromptResponse = {
  prompt: string
  summary: {
    activeCount: number
    stagingCount: number
    areas: number
    locations: number
  }
}

export type StorageItemRow = {
  id: string
  name: string
  area: string | null
  location: string | null
  parent_label: string | null
  child_label: string | null
  reason: string | null
  aliases: string[] | null
  tags: string[] | null
  search_text: string | null
  status: ItemStatus | null
  staging_note: string | null
  llm_suggestion: string | null
  created_at: string | null
  updated_at: string | null
}

function normalizeText(value: unknown = '') {
  return String(value).normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function ensureStatus(value: unknown): ItemStatus {
  return value === 'staging' ? 'staging' : 'active'
}

function sanitizeList(value: unknown) {
  if (!Array.isArray(value)) {
    return []
  }

  return [...new Set(value.map((entry) => normalizeText(entry)).filter(Boolean))]
}

function buildTags(item: InventoryItem) {
  return [
    ...new Set(
      [
        (item.status ?? 'active') === 'staging' ? '暫存區' : item.area.replace('家裡-', ''),
        item.parentLabel,
        item.childLabel,
      ].filter(Boolean),
    ),
  ]
}

function createSearchText(item: InventoryItem) {
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

export function normalizeForSearch(value: string) {
  return value.toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim()
}

export function buildPath(item: InventoryItem) {
  const status = item.status ?? 'active'
  const segments = [item.area, item.location, item.parentLabel, item.childLabel].filter(Boolean)

  if (status === 'staging') {
    if (segments.length === 0) {
      return '暫存區 > 待 LLM 建議'
    }

    return `暫存區候選 > ${segments.join(' > ')}`
  }

  return segments.join(' > ')
}

export function toEnrichedItem(item: InventoryItem): EnrichedItem {
  return {
    ...item,
    status: item.status ?? 'active',
    path: buildPath(item),
    normalizedSearchText: normalizeForSearch(
      [
        item.searchText,
        item.stagingNote,
        item.llmSuggestion,
        item.status ?? 'active',
        buildPath(item),
      ]
        .filter(Boolean)
        .join(' '),
    ),
  }
}

export function normalizeInventoryItem(input: Partial<InventoryItem>): InventoryItem {
  const now = new Date().toISOString()
  const item: InventoryItem = {
    id: normalizeText(input.id) || `item-${crypto.randomUUID()}`,
    name: normalizeText(input.name),
    area: normalizeText(input.area),
    location: normalizeText(input.location),
    parentLabel: normalizeText(input.parentLabel),
    childLabel: normalizeText(input.childLabel),
    reason: normalizeText(input.reason),
    aliases: sanitizeList(input.aliases),
    tags: sanitizeList(input.tags),
    status: ensureStatus(input.status),
    stagingNote: normalizeText(input.stagingNote),
    llmSuggestion: normalizeText(input.llmSuggestion),
    createdAt: input.createdAt || now,
    updatedAt: input.updatedAt || now,
    searchText: '',
  }

  item.tags = item.tags.length > 0 ? item.tags : buildTags(item)
  item.searchText = normalizeText(input.searchText) || createSearchText(item)
  return item
}

export function fromStorageItemRow(row: StorageItemRow): InventoryItem {
  return normalizeInventoryItem({
    id: row.id,
    name: row.name,
    area: row.area ?? '',
    location: row.location ?? '',
    parentLabel: row.parent_label ?? '',
    childLabel: row.child_label ?? '',
    reason: row.reason ?? '',
    aliases: row.aliases ?? [],
    tags: row.tags ?? [],
    searchText: row.search_text ?? '',
    status: row.status ?? 'active',
    stagingNote: row.staging_note ?? '',
    llmSuggestion: row.llm_suggestion ?? '',
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  })
}

export function toStorageItemRow(item: InventoryItem): StorageItemRow {
  const normalized = normalizeInventoryItem(item)

  return {
    id: normalized.id,
    name: normalized.name,
    area: normalized.area,
    location: normalized.location,
    parent_label: normalized.parentLabel,
    child_label: normalized.childLabel,
    reason: normalized.reason,
    aliases: normalized.aliases,
    tags: normalized.tags,
    search_text: normalized.searchText,
    status: normalized.status ?? 'active',
    staging_note: normalized.stagingNote ?? '',
    llm_suggestion: normalized.llmSuggestion ?? '',
    created_at: normalized.createdAt ?? new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }
}

export function buildReviewPrompt(items: InventoryItem[]): ReviewPromptResponse {
  const activeItems = items.filter((item) => (item.status ?? 'active') === 'active')
  const stagingItems = items.filter((item) => (item.status ?? 'active') === 'staging')
  const areaSet = new Set(activeItems.map((item) => item.area).filter(Boolean))
  const locationSet = new Set(activeItems.map((item) => item.location).filter(Boolean))

  const grouped = new Map<
    string,
    {
      area: string
      location: string
      parentLabel: string
      childLabel: string
      reason: string
      items: string[]
    }
  >()

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
    grouped.get(key)?.items.push(item.name)
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
          const candidate =
            [item.area, item.location, item.parentLabel, item.childLabel].filter(Boolean).join(' > ') || '尚未指定'

          return `${index + 1}. 名稱：${item.name}\n   暫存說明：${item.stagingNote || '未填寫'}\n   目前候選位置：${candidate}\n   背景備註：${item.reason || '未填寫'}\n   既有 LLM 建議：${item.llmSuggestion || '無'}`
        })
        .join('\n')
    : '目前暫存區為空。'

  return {
    prompt: [
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
    ].join('\n'),
    summary: {
      activeCount: activeItems.length,
      stagingCount: stagingItems.length,
      areas: areaSet.size,
      locations: locationSet.size,
    },
  }
}
