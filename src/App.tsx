import {
  Fragment,
  type ChangeEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'
import './App.css'
import seedInventory from './data/inventory.json'
import {
  buildPlacementTags,
  buildReviewPrompt,
  normalizeForSearch,
  normalizeInventoryItem,
  toEnrichedItem,
  toStorageItemRow,
  type EnrichedItem,
  type InventoryItem,
  type ItemStatus,
  type ReviewPromptResponse,
  type StorageItemRow,
  fromStorageItemRow,
} from './lib/inventory'
import { isSupabaseConfigured, sharedPassword, supabase } from './lib/supabase'

type Stat = {
  label: string
  value: string
}

type InventoryDraft = {
  id?: string
  name: string
  area: string
  location: string
  parentLabel: string
  childLabel: string
  reason: string
  aliasesText: string
  tagsText: string
  status: ItemStatus
  stagingNote: string
  llmSuggestion: string
}

type PlacementDraft = {
  area: string
  location: string
  parentLabel: string
  childLabel: string
}

type EditorMode = 'create' | 'edit' | null

const sourceUrl = 'https://gemini.google.com/share/9ed1050e454e'
const passwordHint = sharedPassword
const tokenStorageKey = 'storage-organizer-editor'

const suggestionKeywords = ['驗電筆', 'WAGO', '螺絲', '鉸鏈', 'RJ45', '止洩帶', '電池', '延長線']

const synonymGroups = [
  ['延長線', '排插', '插座延長'],
  ['合頁', '鉸鏈'],
  ['網路頭', 'RJ45'],
  ['止洩帶', '密封帶'],
  ['束帶', '理線器', '理線束帶'],
  ['螺絲', '螺栓'],
  ['變壓器', '電源模組'],
]

const workflowIdeas = [
  '先把新物品丟進暫存區，寫下用途、使用頻率、危險性、是否怕潮。',
  '按一下「複製 LLM 覆核提示詞」，貼給高階 LLM 做結構評分與歸位建議。',
  '把 LLM 回覆貼回暫存物品的「LLM 建議」，再手動確認或直接歸檔。',
  '若你要，我之後還可以再加「一鍵套用 LLM JSON 建議」自動歸檔。',
]

const emptyDraft = (status: ItemStatus = 'active'): InventoryDraft => ({
  name: '',
  area: '',
  location: '',
  parentLabel: '',
  childLabel: '',
  reason: '',
  aliasesText: '',
  tagsText: '',
  status,
  stagingNote: '',
  llmSuggestion: '',
})

const fallbackSeedItems = (seedInventory as InventoryItem[]).map((item) => normalizeInventoryItem(item))

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildSearchVariants(token: string) {
  const normalizedToken = normalizeForSearch(token)
  const variants = new Set([normalizedToken])

  for (const group of synonymGroups) {
    const normalizedGroup = group.map(normalizeForSearch)
    if (normalizedGroup.includes(normalizedToken)) {
      normalizedGroup.forEach((variant) => variants.add(variant))
    }
  }

  return [...variants]
}

function buildHighlightTokens(query: string) {
  return query
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean)
}

function highlightText(text: string, query: string) {
  const tokens = buildHighlightTokens(query)

  if (tokens.length === 0) {
    return text
  }

  const matcher = new RegExp(`(${tokens.map(escapeRegExp).join('|')})`, 'gi')
  const parts = text.split(matcher)

  return parts.map((part, index) => {
    const isMatch = tokens.some((token) => normalizeForSearch(token) === normalizeForSearch(part))

    if (!isMatch) {
      return <Fragment key={`${part}-${index}`}>{part}</Fragment>
    }

    return <mark key={`${part}-${index}`}>{part}</mark>
  })
}

function parseDelimitedText(value: string) {
  return value
    .split(/[,\n、]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
}

function uniqueValues(values: string[]) {
  return [...new Set(values.filter(Boolean))]
}

function emptyPlacementDraft(): PlacementDraft {
  return {
    area: '',
    location: '',
    parentLabel: '',
    childLabel: '',
  }
}

function toPlacementDraft(item: Pick<EnrichedItem, 'area' | 'location' | 'parentLabel' | 'childLabel'>): PlacementDraft {
  return {
    area: item.area,
    location: item.location,
    parentLabel: item.parentLabel,
    childLabel: item.childLabel,
  }
}

function hasCompletePlacement(placement: PlacementDraft) {
  return Boolean(placement.area && placement.location && placement.parentLabel && placement.childLabel)
}

function mergePlacementTags(existingItem: InventoryItem | undefined, nextItem: InventoryItem) {
  const existingPlacementTags = new Set(existingItem ? buildPlacementTags(existingItem) : [])
  const customTags = existingItem?.tags.filter((tag) => !existingPlacementTags.has(tag)) ?? []

  return uniqueValues([...customTags, ...buildPlacementTags(nextItem)])
}

function toDraft(item: EnrichedItem): InventoryDraft {
  return {
    id: item.id,
    name: item.name,
    area: item.area,
    location: item.location,
    parentLabel: item.parentLabel,
    childLabel: item.childLabel,
    reason: item.reason,
    aliasesText: item.aliases.join(', '),
    tagsText: item.tags.join(', '),
    status: item.status,
    stagingNote: item.stagingNote ?? '',
    llmSuggestion: item.llmSuggestion ?? '',
  }
}

async function copyToClipboard(text: string) {
  await navigator.clipboard.writeText(text)
}

function App() {
  const [items, setItems] = useState<InventoryItem[]>([])
  const [lastUpdated, setLastUpdated] = useState('')
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedArea, setSelectedArea] = useState('全部區域')
  const [selectedLocation, setSelectedLocation] = useState('全部位置')
  const [selectedParent, setSelectedParent] = useState('全部大類')
  const [selectedChild, setSelectedChild] = useState('全部子類')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [authToken, setAuthToken] = useState<string | null>(null)
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [editorMode, setEditorMode] = useState<EditorMode>(null)
  const [draft, setDraft] = useState<InventoryDraft>(emptyDraft())
  const [promptSummary, setPromptSummary] = useState<ReviewPromptResponse['summary'] | null>(null)
  const [hasLoadedCloudData, setHasLoadedCloudData] = useState(false)
  const [quickMoveItemId, setQuickMoveItemId] = useState<string | null>(null)
  const [quickMoveDraft, setQuickMoveDraft] = useState<PlacementDraft>(emptyPlacementDraft())

  const inventory = useMemo(() => items.map(toEnrichedItem), [items])
  const activeItems = useMemo(() => inventory.filter((item) => item.status === 'active'), [inventory])
  const stagingItems = useMemo(() => inventory.filter((item) => item.status === 'staging'), [inventory])

  const draftAreaOptions = useMemo(
    () => uniqueValues([draft.area, ...activeItems.map((item) => item.area)]),
    [activeItems, draft.area],
  )

  const draftLocationOptions = useMemo(() => {
    const candidates =
      draft.area === ''
        ? activeItems
        : activeItems.filter((item) => item.area === draft.area)

    return uniqueValues([draft.location, ...candidates.map((item) => item.location)])
  }, [activeItems, draft.area, draft.location])

  const draftParentOptions = useMemo(() => {
    const candidates = activeItems.filter((item) => {
      if (draft.area && item.area !== draft.area) {
        return false
      }

      if (draft.location && item.location !== draft.location) {
        return false
      }

      return true
    })

    return uniqueValues([draft.parentLabel, ...candidates.map((item) => item.parentLabel)])
  }, [activeItems, draft.area, draft.location, draft.parentLabel])

  const draftChildOptions = useMemo(() => {
    const candidates = activeItems.filter((item) => {
      if (draft.area && item.area !== draft.area) {
        return false
      }

      if (draft.location && item.location !== draft.location) {
        return false
      }

      if (draft.parentLabel && item.parentLabel !== draft.parentLabel) {
        return false
      }

      return true
    })

    return uniqueValues([draft.childLabel, ...candidates.map((item) => item.childLabel)])
  }, [activeItems, draft.area, draft.location, draft.parentLabel, draft.childLabel])

  const quickMoveAreaOptions = useMemo(
    () => uniqueValues([quickMoveDraft.area, ...activeItems.map((item) => item.area)]),
    [activeItems, quickMoveDraft.area],
  )

  const quickMoveLocationOptions = useMemo(() => {
    const candidates =
      quickMoveDraft.area === ''
        ? activeItems
        : activeItems.filter((item) => item.area === quickMoveDraft.area)

    return uniqueValues([quickMoveDraft.location, ...candidates.map((item) => item.location)])
  }, [activeItems, quickMoveDraft.area, quickMoveDraft.location])

  const quickMoveParentOptions = useMemo(() => {
    const candidates = activeItems.filter((item) => {
      if (quickMoveDraft.area && item.area !== quickMoveDraft.area) {
        return false
      }

      if (quickMoveDraft.location && item.location !== quickMoveDraft.location) {
        return false
      }

      return true
    })

    return uniqueValues([quickMoveDraft.parentLabel, ...candidates.map((item) => item.parentLabel)])
  }, [activeItems, quickMoveDraft.area, quickMoveDraft.location, quickMoveDraft.parentLabel])

  const quickMoveChildOptions = useMemo(() => {
    const candidates = activeItems.filter((item) => {
      if (quickMoveDraft.area && item.area !== quickMoveDraft.area) {
        return false
      }

      if (quickMoveDraft.location && item.location !== quickMoveDraft.location) {
        return false
      }

      if (quickMoveDraft.parentLabel && item.parentLabel !== quickMoveDraft.parentLabel) {
        return false
      }

      return true
    })

    return uniqueValues([quickMoveDraft.childLabel, ...candidates.map((item) => item.childLabel)])
  }, [activeItems, quickMoveDraft.area, quickMoveDraft.location, quickMoveDraft.parentLabel, quickMoveDraft.childLabel])

  const loadItems = useCallback(
    async (showLoader: boolean) => {
      if (showLoader) {
        setIsLoading(true)
      }

      try {
        if (!supabase) {
          setItems(fallbackSeedItems)
          const fallbackUpdatedAt = [...fallbackSeedItems]
            .map((item) => item.updatedAt || item.createdAt || '')
            .sort()
            .at(-1)
          setLastUpdated(fallbackUpdatedAt || '')
          return
        }

        const { data, error } = await supabase
          .from('storage_items')
          .select('*')
          .order('updated_at', { ascending: false })

        if (error) {
          throw error
        }

        const nextItems = ((data ?? []) as StorageItemRow[]).map((row) => fromStorageItemRow(row))
        const latestUpdatedAt = [...nextItems]
          .map((item) => item.updatedAt || item.createdAt || '')
          .sort()
          .at(-1)

        setItems(nextItems)
        setLastUpdated(latestUpdatedAt || '')
        setHasLoadedCloudData(true)
      } catch (error) {
        setStatusMessage(error instanceof Error ? error.message : '載入資料失敗。')
      } finally {
        if (showLoader) {
          setIsLoading(false)
        }
      }
    },
    [],
  )

  useEffect(() => {
    const savedToken = window.localStorage.getItem(tokenStorageKey)
    if (savedToken) {
      setAuthToken(savedToken)
    }
    void loadItems(true)
  }, [loadItems])

  useEffect(() => {
    if (!supabase) {
      return
    }

    const intervalId = window.setInterval(() => {
      void loadItems(false)
    }, 15000)

    return () => window.clearInterval(intervalId)
  }, [loadItems])

  const areas = useMemo(
    () => ['全部區域', ...new Set(activeItems.map((item) => item.area))],
    [activeItems],
  )

  const locationCandidates = useMemo(() => {
    return activeItems.filter((item) => {
      if (selectedArea !== '全部區域' && item.area !== selectedArea) {
        return false
      }

      return true
    })
  }, [activeItems, selectedArea])

  const locations = useMemo(
    () => ['全部位置', ...new Set(locationCandidates.map((item) => item.location))],
    [locationCandidates],
  )

  const parentCandidates = useMemo(() => {
    return activeItems.filter((item) => {
      if (selectedArea !== '全部區域' && item.area !== selectedArea) {
        return false
      }

      if (selectedLocation !== '全部位置' && item.location !== selectedLocation) {
        return false
      }

      return true
    })
  }, [activeItems, selectedArea, selectedLocation])

  const parentLabels = useMemo(
    () => ['全部大類', ...new Set(parentCandidates.map((item) => item.parentLabel))],
    [parentCandidates],
  )

  const childCandidates = useMemo(() => {
    return activeItems.filter((item) => {
      if (selectedArea !== '全部區域' && item.area !== selectedArea) {
        return false
      }

      if (selectedLocation !== '全部位置' && item.location !== selectedLocation) {
        return false
      }

      if (selectedParent !== '全部大類' && item.parentLabel !== selectedParent) {
        return false
      }

      return true
    })
  }, [activeItems, selectedArea, selectedLocation, selectedParent])

  const childLabels = useMemo(
    () => ['全部子類', ...new Set(childCandidates.map((item) => item.childLabel))],
    [childCandidates],
  )

  const filteredItems = useMemo(() => {
    const searchGroups = query
      .split(/\s+/)
      .map((token: string) => token.trim())
      .filter(Boolean)
      .map(buildSearchVariants)

    return activeItems.filter((item) => {
      if (selectedArea !== '全部區域' && item.area !== selectedArea) {
        return false
      }

      if (selectedLocation !== '全部位置' && item.location !== selectedLocation) {
        return false
      }

      if (selectedParent !== '全部大類' && item.parentLabel !== selectedParent) {
        return false
      }

      if (selectedChild !== '全部子類' && item.childLabel !== selectedChild) {
        return false
      }

      if (searchGroups.length === 0) {
        return true
      }

      return searchGroups.every((variants: string[]) =>
        variants.some((variant: string) => item.normalizedSearchText.includes(variant)),
      )
    })
  }, [activeItems, query, selectedArea, selectedLocation, selectedParent, selectedChild])

  const filteredStagingItems = useMemo(() => {
    const searchGroups = query
      .split(/\s+/)
      .map((token: string) => token.trim())
      .filter(Boolean)
      .map(buildSearchVariants)

    return stagingItems.filter((item) => {
      if (searchGroups.length === 0) {
        return true
      }

      return searchGroups.every((variants: string[]) =>
        variants.some((variant: string) => item.normalizedSearchText.includes(variant)),
      )
    })
  }, [query, stagingItems])

  const areaCards = useMemo(() => {
    const counts = activeItems.reduce<Record<string, number>>((accumulator, item) => {
      accumulator[item.area] = (accumulator[item.area] ?? 0) + 1
      return accumulator
    }, {})

    return Object.entries(counts)
      .map(([area, count]) => ({ area, count }))
      .sort((left, right) => right.count - left.count)
  }, [activeItems])

  const stats = useMemo<Stat[]>(
    () => [
      { label: '正式收納', value: String(activeItems.length) },
      { label: '暫存區', value: String(stagingItems.length) },
      { label: '收納區域', value: String(areas.length - 1) },
      { label: '櫃位/位置', value: String(locations.length - 1) },
    ],
    [activeItems.length, areas.length, locations.length, stagingItems.length],
  )

  const handleCopyPath = async (item: EnrichedItem) => {
    try {
      await copyToClipboard(item.path)
      setCopiedId(item.id)
      window.setTimeout(
        () => setCopiedId((current: string | null) => (current === item.id ? null : current)),
        1800,
      )
    } catch {
      setCopiedId(null)
    }
  }

  const handleQueryChange = (event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value)
  }

  const handleAreaChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedArea(event.target.value)
    setSelectedLocation('全部位置')
    setSelectedParent('全部大類')
    setSelectedChild('全部子類')
  }

  const handleLocationChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedLocation(event.target.value)
    setSelectedParent('全部大類')
    setSelectedChild('全部子類')
  }

  const handleParentChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedParent(event.target.value)
    setSelectedChild('全部子類')
  }

  const handleChildChange = (event: ChangeEvent<HTMLSelectElement>) => {
    setSelectedChild(event.target.value)
  }

  const clearFilters = () => {
    setQuery('')
    setSelectedArea('全部區域')
    setSelectedLocation('全部位置')
    setSelectedParent('全部大類')
    setSelectedChild('全部子類')
  }

  const handlePasswordChange = (event: ChangeEvent<HTMLInputElement>) => {
    setPassword(event.target.value)
  }

  const handleDraftChange =
    (field: keyof InventoryDraft) =>
    (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => {
      setDraft((current) => ({
        ...current,
        [field]: event.target.value,
      }))
    }

  const handlePlacementChange =
    (field: 'area' | 'location' | 'parentLabel' | 'childLabel' | 'status') =>
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value

      setDraft((current) => {
        if (field === 'status') {
          return {
            ...current,
            status: value as ItemStatus,
          }
        }

        if (field === 'area') {
          return {
            ...current,
            area: value,
            location: '',
            parentLabel: '',
            childLabel: '',
          }
        }

        if (field === 'location') {
          return {
            ...current,
            location: value,
            parentLabel: '',
            childLabel: '',
          }
        }

        if (field === 'parentLabel') {
          return {
            ...current,
            parentLabel: value,
            childLabel: '',
          }
        }

        return {
          ...current,
          childLabel: value,
        }
      })
    }

  const handleQuickMovePlacementChange =
    (field: keyof PlacementDraft) =>
    (event: ChangeEvent<HTMLSelectElement>) => {
      const value = event.target.value

      setQuickMoveDraft((current) => {
        if (field === 'area') {
          return {
            area: value,
            location: '',
            parentLabel: '',
            childLabel: '',
          }
        }

        if (field === 'location') {
          return {
            ...current,
            location: value,
            parentLabel: '',
            childLabel: '',
          }
        }

        if (field === 'parentLabel') {
          return {
            ...current,
            parentLabel: value,
            childLabel: '',
          }
        }

        return {
          ...current,
          childLabel: value,
        }
      })
    }

  const handleLogin = async (event: { preventDefault: () => void }) => {
    event.preventDefault()
    setAuthError('')

    try {
      if (!supabase) {
        throw new Error('尚未連接 Supabase，請先完成雲端設定。')
      }

      if (password !== passwordHint) {
        throw new Error('密碼錯誤。')
      }

      setAuthToken('granted')
      window.localStorage.setItem(tokenStorageKey, 'granted')
      setPassword('')
      setStatusMessage('已解鎖共同編輯模式。')
    } catch (error) {
      setAuthError(error instanceof Error ? error.message : '登入失敗。')
    }
  }

  const handleLogout = () => {
    setAuthToken(null)
    window.localStorage.removeItem(tokenStorageKey)
    setEditorMode(null)
    setDraft(emptyDraft())
    setQuickMoveItemId(null)
    setQuickMoveDraft(emptyPlacementDraft())
    setStatusMessage('已登出編輯模式。')
  }

  const startCreate = (status: ItemStatus) => {
    setEditorMode('create')
    setDraft(emptyDraft(status))
    setQuickMoveItemId(null)
    setQuickMoveDraft(emptyPlacementDraft())
    setStatusMessage('')
  }

  const startEdit = (item: EnrichedItem) => {
    setEditorMode('edit')
    setDraft(toDraft(item))
    setQuickMoveItemId(null)
    setQuickMoveDraft(emptyPlacementDraft())
    setStatusMessage('')
  }

  const cancelEdit = () => {
    setEditorMode(null)
    setDraft(emptyDraft())
  }

  const cancelQuickMove = () => {
    setQuickMoveItemId(null)
    setQuickMoveDraft(emptyPlacementDraft())
  }

  const startQuickMove = (item: EnrichedItem) => {
    if (quickMoveItemId === item.id) {
      cancelQuickMove()
      return
    }

    setEditorMode(null)
    setDraft(emptyDraft())
    setQuickMoveItemId(item.id)
    setQuickMoveDraft(toPlacementDraft(item))
    setStatusMessage('')
  }

  const persistItem = async (
    input: Partial<InventoryItem>,
    options: {
      successMessage: string
      refreshPlacementTags?: boolean
      onSuccess?: () => void
    },
  ) => {
    if (!authToken) {
      setAuthError('請先登入後再編輯。')
      return
    }

    setIsSaving(true)
    setStatusMessage('')

    try {
      if (!supabase) {
        throw new Error('尚未連接 Supabase，請先完成雲端設定。')
      }

      const existingItem = input.id ? items.find((item) => item.id === input.id) : undefined
      const basePayload = {
        id: existingItem?.id ?? input.id,
        name: input.name ?? existingItem?.name,
        area: input.area ?? existingItem?.area,
        location: input.location ?? existingItem?.location,
        parentLabel: input.parentLabel ?? existingItem?.parentLabel,
        childLabel: input.childLabel ?? existingItem?.childLabel,
        reason: input.reason ?? existingItem?.reason,
        aliases: input.aliases ?? existingItem?.aliases ?? [],
        tags: input.tags ?? existingItem?.tags ?? [],
        status: input.status ?? existingItem?.status ?? 'active',
        stagingNote: input.stagingNote ?? existingItem?.stagingNote,
        llmSuggestion: input.llmSuggestion ?? existingItem?.llmSuggestion,
        createdAt: existingItem?.createdAt ?? input.createdAt,
      }

      const normalizedItem = normalizeInventoryItem(basePayload)
      const itemForSave = options.refreshPlacementTags
        ? {
            ...normalizedItem,
            tags: mergePlacementTags(existingItem, normalizedItem),
          }
        : normalizedItem
      const row = toStorageItemRow(itemForSave)

      const { error } = existingItem
        ? await supabase.from('storage_items').upsert(row, { onConflict: 'id' })
        : await supabase.from('storage_items').insert(row)

      if (error) {
        throw error
      }

      await loadItems(false)
      options.onSuccess?.()
      setStatusMessage(options.successMessage)
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '儲存失敗。')
    } finally {
      setIsSaving(false)
    }
  }

  const saveDraft = async (statusOverride?: ItemStatus) => {
    await persistItem(
      {
        id: draft.id,
        name: draft.name,
        area: draft.area,
        location: draft.location,
        parentLabel: draft.parentLabel,
        childLabel: draft.childLabel,
        reason: draft.reason,
        aliases: parseDelimitedText(draft.aliasesText),
        tags: parseDelimitedText(draft.tagsText),
        status: statusOverride ?? draft.status,
        stagingNote: draft.stagingNote,
        llmSuggestion: draft.llmSuggestion,
      },
      {
        successMessage: (statusOverride ?? draft.status) === 'staging' ? '已儲存到暫存區。' : '已完成歸檔。',
        onSuccess: () => {
          setEditorMode(null)
          setDraft(emptyDraft())
        },
      },
    )
  }

  const deleteItem = async (item: EnrichedItem) => {
    if (!authToken) {
      setAuthError('請先登入後再刪除。')
      return
    }

    const confirmed = window.confirm(`確定要刪除「${item.name}」嗎？`)
    if (!confirmed) {
      return
    }

    setIsSaving(true)

    try {
      if (!supabase) {
        throw new Error('尚未連接 Supabase，請先完成雲端設定。')
      }

      const { error } = await supabase.from('storage_items').delete().eq('id', item.id)

      if (error) {
        throw error
      }

      await loadItems(false)
      if (draft.id === item.id) {
        cancelEdit()
      }
      setStatusMessage('已刪除物品。')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '刪除失敗。')
    } finally {
      setIsSaving(false)
    }
  }

  const copyReviewPrompt = async () => {
    try {
      const payload = buildReviewPrompt(items)
      await copyToClipboard(payload.prompt)
      setPromptSummary(payload.summary)
      setStatusMessage('已複製 LLM 覆核提示詞，可直接貼給高階模型。')
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '無法複製提示詞。')
    }
  }

  const copyStagingItemPrompt = async (item: EnrichedItem) => {
    const prompt = [
      '請協助判斷下列暫存物品的最佳收納位置。',
      `物品名稱：${item.name}`,
      `暫存說明：${item.stagingNote || '未填寫'}`,
      `目前候選位置：${item.path}`,
      `LLM 建議欄：${item.llmSuggestion || '尚未填寫'}`,
      `別名：${item.aliases.join(', ') || '無'}`,
      `標籤：${item.tags.join(', ') || '無'}`,
      `放置理由/背景：${item.reason || '未填寫'}`,
      '請回覆：1. 建議區域 2. 建議位置 3. 建議 Parent 4. 建議 Child 5. 原因 6. 若不適合歸檔請說明應維持暫存的理由。',
    ].join('\n')

    await copyToClipboard(prompt)
    setStatusMessage(`已複製「${item.name}」的 LLM 提問片段。`)
  }

  const promoteStagingItem = async (item: EnrichedItem) => {
    if (!item.area || !item.location || !item.parentLabel || !item.childLabel) {
      startEdit(item)
      setStatusMessage('這筆暫存物品還沒有完整位置，請先補齊後再歸檔。')
      return
    }

    await persistItem(
      {
        id: item.id,
        name: item.name,
        area: item.area,
        location: item.location,
        parentLabel: item.parentLabel,
        childLabel: item.childLabel,
        reason: item.reason,
        aliases: item.aliases,
        tags: item.tags,
        stagingNote: item.stagingNote,
        llmSuggestion: item.llmSuggestion,
        createdAt: item.createdAt,
          status: 'active',
      },
      {
        successMessage: `已將「${item.name}」從暫存區歸檔。`,
        refreshPlacementTags: true,
        onSuccess: () => {
          if (quickMoveItemId === item.id) {
            cancelQuickMove()
          }
        },
      },
    )
  }

  const saveQuickMove = async (item: EnrichedItem, nextStatus: ItemStatus) => {
    if (nextStatus === 'active' && !hasCompletePlacement(quickMoveDraft)) {
      setStatusMessage('要歸檔或搬移正式物品前，請先完整選擇區域、位置、大類、子類。')
      return
    }

    await persistItem(
      {
        id: item.id,
        name: item.name,
        area: quickMoveDraft.area,
        location: quickMoveDraft.location,
        parentLabel: quickMoveDraft.parentLabel,
        childLabel: quickMoveDraft.childLabel,
        reason: item.reason,
        aliases: item.aliases,
        tags: item.tags,
        status: nextStatus,
        stagingNote: item.stagingNote,
        llmSuggestion: item.llmSuggestion,
        createdAt: item.createdAt,
      },
      {
        successMessage:
          nextStatus === 'active' && item.status === 'staging'
            ? `已定位並歸檔「${item.name}」。`
            : item.status === 'staging'
              ? `已更新「${item.name}」的候選位置。`
              : `已搬移「${item.name}」到新位置。`,
        refreshPlacementTags: true,
        onSuccess: cancelQuickMove,
      },
    )
  }

  const hasEditor = editorMode !== null
  const isLoggedIn = Boolean(authToken)
  const isReadOnly = !isSupabaseConfigured
  const syncStatusText = isReadOnly
    ? '尚未連接雲端資料庫，目前顯示唯讀種子資料。'
    : hasLoadedCloudData
      ? '已連接 Supabase 共享資料。'
      : '正在連接 Supabase 共享資料。'

  return (
    <main className="app-shell">
      <section className="hero-section">
        <div className="hero-copy">
          <span className="eyebrow">新家物資分流清單</span>
          <h1>極簡收納定位系統</h1>
          <p className="hero-description">
            用選單維持收納結構一致性，用暫存區承接未定案物品，再交給高階 LLM 覆核後歸檔。
          </p>
          <div className="hero-actions">
            <a className="primary-link" href={sourceUrl} target="_blank" rel="noreferrer">
              查看原始來源
            </a>
            <button type="button" className="ghost-button" onClick={clearFilters}>
              清空所有篩選
            </button>
          </div>
        </div>
        <div className="hero-panel">
          <h2>重點</h2>
          <ul>
            <li>位置改為選單式編輯，避免打錯字。</li>
            <li>{isReadOnly ? '目前為唯讀展示模式。' : isLoggedIn ? '已解鎖編輯模式。' : `登入密碼：${passwordHint}`}</li>
            <li>{lastUpdated ? `最近同步：${new Date(lastUpdated).toLocaleString()}` : '尚未取得同步時間。'}</li>
          </ul>
        </div>
      </section>

      <section className="control-panel">
        <label className="search-box">
          <span>搜尋框</span>
          <input
            value={query}
            onChange={handleQueryChange}
            placeholder="搜尋物品、區域、櫃位、標籤，例如：驗電筆 書房"
          />
        </label>

        <p className="filter-hint">篩選器會依區域、位置、大類、子類逐步收斂，切換上層時下層會自動重置。</p>

        <div className="filter-grid">
          <label>
            <span>區域</span>
            <select value={selectedArea} onChange={handleAreaChange}>
              {areas.map((area: string) => (
                <option key={area} value={area}>
                  {area}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>位置</span>
            <select value={selectedLocation} onChange={handleLocationChange}>
              {locations.map((location: string) => (
                <option key={location} value={location}>
                  {location}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>大類</span>
            <select value={selectedParent} onChange={handleParentChange}>
              {parentLabels.map((parentLabel: string) => (
                <option key={parentLabel} value={parentLabel}>
                  {parentLabel}
                </option>
              ))}
            </select>
          </label>

          <label>
            <span>子類</span>
            <select value={selectedChild} onChange={handleChildChange}>
              {childLabels.map((childLabel: string) => (
                <option key={childLabel} value={childLabel}>
                  {childLabel}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="suggestions">
          {suggestionKeywords.map((keyword) => (
            <button key={keyword} type="button" onClick={() => setQuery(keyword)}>
              {keyword}
            </button>
          ))}
        </div>
      </section>

      <section className="stats-grid">
        {stats.map((stat: Stat) => (
          <article key={stat.label} className="stat-card">
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
          </article>
        ))}
      </section>

      <section className="content-grid">
        <aside className="sidebar">
          <div className="panel">
            <div className="panel-heading">
              <h2>共同編輯</h2>
              <span>{isReadOnly ? '唯讀' : isLoggedIn ? '已登入' : '鎖定中'}</span>
            </div>

            {isReadOnly ? (
              <div className="auth-card">
                <p>{syncStatusText}</p>
                <p className="subtle-text">完成 Supabase 設定後，這裡就會開放共同編輯與跨裝置同步。</p>
              </div>
            ) : isLoggedIn ? (
              <div className="auth-card">
                <p>{syncStatusText}</p>
                <div className="stack-buttons">
                  <button type="button" onClick={() => startCreate('active')}>
                    新增正式物品
                  </button>
                  <button type="button" onClick={() => startCreate('staging')}>
                    新增暫存物品
                  </button>
                  <button type="button" onClick={() => void loadItems(false)}>
                    立即同步
                  </button>
                  <button type="button" onClick={() => void copyReviewPrompt()}>
                    複製 LLM 覆核提示詞
                  </button>
                  <button type="button" className="danger-soft" onClick={handleLogout}>
                    登出編輯模式
                  </button>
                </div>
              </div>
            ) : (
              <form className="auth-card" onSubmit={handleLogin}>
                <label className="search-box">
                  <span>編輯密碼</span>
                  <input
                    type="password"
                    value={password}
                    onChange={handlePasswordChange}
                    placeholder="輸入共享密碼"
                  />
                </label>
                <button type="submit" className="primary-link button-fill">
                  進入編輯模式
                </button>
                <p className="subtle-text">{syncStatusText}</p>
                {authError ? <p className="error-text">{authError}</p> : null}
              </form>
            )}
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>LLM 覆核</h2>
              <span>{promptSummary ? `${promptSummary.stagingCount} 件暫存` : '一鍵複製'}</span>
            </div>
            <div className="auth-card">
              <p>匯出目前結構與暫存區，貼給高階 LLM 做評分與位置建議。</p>
              <div className="stack-buttons">
                <button type="button" onClick={() => void copyReviewPrompt()}>
                  複製完整覆核提示詞
                </button>
              </div>
              {promptSummary ? (
                <p className="subtle-text">
                  提示詞摘要：正式收納 {promptSummary.activeCount} 件，暫存 {promptSummary.stagingCount} 件，區域 {promptSummary.areas} 個，位置 {promptSummary.locations} 個。
                </p>
              ) : null}
            </div>
          </div>

          {hasEditor && !isReadOnly ? (
            <div className="panel editor-panel">
              <div className="panel-heading">
                <h2>{editorMode === 'edit' ? '編輯物品' : '新增物品'}</h2>
                <span>{draft.status === 'staging' ? '暫存模式' : '正式歸檔模式'}</span>
              </div>

              <p className="editor-note">位置欄位改用現有收納層級選單，降低手動輸入誤差。</p>

              <div className="editor-grid">
                <label>
                  <span>物品名稱</span>
                  <input value={draft.name} onChange={handleDraftChange('name')} />
                </label>
                <label>
                  <span>狀態</span>
                  <select value={draft.status} onChange={handlePlacementChange('status')}>
                    <option value="active">正式收納</option>
                    <option value="staging">暫存區</option>
                  </select>
                </label>
                <label>
                  <span>區域</span>
                  <select value={draft.area} onChange={handlePlacementChange('area')}>
                    <option value="">{draft.status === 'staging' ? '尚未決定' : '請選擇區域'}</option>
                    {draftAreaOptions.map((area) => (
                      <option key={area} value={area}>
                        {area}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>位置</span>
                  <select value={draft.location} onChange={handlePlacementChange('location')}>
                    <option value="">{draft.status === 'staging' ? '尚未決定' : '請選擇位置'}</option>
                    {draftLocationOptions.map((location) => (
                      <option key={location} value={location}>
                        {location}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>大類</span>
                  <select value={draft.parentLabel} onChange={handlePlacementChange('parentLabel')}>
                    <option value="">{draft.status === 'staging' ? '尚未決定' : '請選擇大類'}</option>
                    {draftParentOptions.map((parentLabel) => (
                      <option key={parentLabel} value={parentLabel}>
                        {parentLabel}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>子類</span>
                  <select value={draft.childLabel} onChange={handlePlacementChange('childLabel')}>
                    <option value="">{draft.status === 'staging' ? '尚未決定' : '請選擇子類'}</option>
                    {draftChildOptions.map((childLabel) => (
                      <option key={childLabel} value={childLabel}>
                        {childLabel}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  <span>別名</span>
                  <input
                    value={draft.aliasesText}
                    onChange={handleDraftChange('aliasesText')}
                    placeholder="用逗號分隔"
                  />
                </label>
                <label>
                  <span>標籤</span>
                  <input
                    value={draft.tagsText}
                    onChange={handleDraftChange('tagsText')}
                    placeholder="用逗號分隔"
                  />
                </label>
                <label className="full-width">
                  <span>放置理由</span>
                  <textarea rows={3} value={draft.reason} onChange={handleDraftChange('reason')} />
                </label>
                <label className="full-width">
                  <span>暫存說明</span>
                  <textarea
                    rows={3}
                    value={draft.stagingNote}
                    onChange={handleDraftChange('stagingNote')}
                    placeholder="例如：新買未決定、低頻工具、怕潮、可能靠近電腦桌使用"
                  />
                </label>
                <label className="full-width">
                  <span>LLM 建議</span>
                  <textarea
                    rows={4}
                    value={draft.llmSuggestion}
                    onChange={handleDraftChange('llmSuggestion')}
                    placeholder="把 LLM 給你的建議貼在這裡，之後可以再決定是否歸檔"
                  />
                </label>
              </div>

              <div className="stack-buttons">
                <button type="button" onClick={() => void saveDraft(draft.status)} disabled={isSaving}>
                  {isSaving ? '儲存中...' : draft.status === 'staging' ? '儲存到暫存區' : '儲存正式歸檔'}
                </button>
                <button type="button" onClick={() => void saveDraft('active')} disabled={isSaving}>
                  儲存並歸檔
                </button>
                <button type="button" onClick={() => void saveDraft('staging')} disabled={isSaving}>
                  儲存為暫存
                </button>
                <button type="button" onClick={cancelEdit}>
                  取消編輯
                </button>
              </div>
            </div>
          ) : null}

          <div className="panel">
            <div className="panel-heading">
              <h2>區域捷徑</h2>
              <span>{areaCards.length} 區</span>
            </div>
            <div className="area-list">
              {areaCards.map(({ area, count }) => (
                <button
                  key={area}
                  type="button"
                  className={area === selectedArea ? 'active' : ''}
                  onClick={() => {
                    setSelectedArea(area)
                    setSelectedLocation('全部位置')
                    setSelectedParent('全部大類')
                    setSelectedChild('全部子類')
                  }}
                >
                  <span>{area}</span>
                  <strong>{count}</strong>
                </button>
              ))}
            </div>
          </div>

          <div className="panel">
            <div className="panel-heading">
              <h2>工作流</h2>
              <span>LLM 協作</span>
            </div>
            <ul className="idea-list">
              {workflowIdeas.map((idea) => (
                <li key={idea}>{idea}</li>
              ))}
            </ul>
          </div>
        </aside>

        <section className="workspace-column">
          <section className="results-panel">
            <div className="panel-heading">
              <h2>正式收納</h2>
              <span>{filteredItems.length} 筆 {isLoading ? '載入中' : ''}</span>
            </div>

            {statusMessage ? <div className="status-banner">{statusMessage}</div> : null}

            {filteredItems.length === 0 ? (
              <div className="empty-state">
                <h3>找不到符合條件的正式收納物品</h3>
                <p>可以試試看移除部分篩選，或改用相近關鍵字，例如 `鉸鏈`、`排插`、`螺栓`。</p>
              </div>
            ) : (
              <div className="results-list">
                {filteredItems.map((item: EnrichedItem) => (
                  <article key={item.id} className="result-card">
                    <div className="result-header">
                      <div>
                        <h3>{highlightText(item.name, query)}</h3>
                        <p>{highlightText(item.path, query)}</p>
                      </div>
                      <div className="card-actions">
                        <button type="button" className="copy-button" onClick={() => void handleCopyPath(item)}>
                          {copiedId === item.id ? '已複製' : '複製路徑'}
                        </button>
                        {isLoggedIn ? (
                          <>
                            <button type="button" className="ghost-inline" onClick={() => startQuickMove(item)}>
                              {quickMoveItemId === item.id ? '收起移動' : '快速移動'}
                            </button>
                            <button type="button" className="ghost-inline" onClick={() => startEdit(item)}>
                              編輯
                            </button>
                            <button type="button" className="danger-inline" onClick={() => void deleteItem(item)}>
                              刪除
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="tag-row">
                      <span>{item.area}</span>
                      <span>{item.location}</span>
                      <span>{item.parentLabel}</span>
                      <span>{item.childLabel}</span>
                    </div>

                    <p className="reason">
                      <strong>放置理由：</strong>
                      {highlightText(item.reason, query)}
                    </p>

                    <div className="result-actions">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedArea(item.area)
                          setSelectedLocation('全部位置')
                          setSelectedParent('全部大類')
                          setSelectedChild('全部子類')
                        }}
                      >
                        只看此區域
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedArea(item.area)
                          setSelectedLocation(item.location)
                          setSelectedParent('全部大類')
                          setSelectedChild('全部子類')
                        }}
                      >
                        只看此位置
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedArea(item.area)
                          setSelectedLocation(item.location)
                          setSelectedParent(item.parentLabel)
                          setSelectedChild('全部子類')
                        }}
                      >
                        只看此大類
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedArea(item.area)
                          setSelectedLocation(item.location)
                          setSelectedParent(item.parentLabel)
                          setSelectedChild(item.childLabel)
                        }}
                      >
                        只看此子類
                      </button>
                    </div>

                    {isLoggedIn && quickMoveItemId === item.id ? (
                      <div className="quick-move-panel">
                        <div className="quick-move-heading">
                          <strong>快速移動</strong>
                          <span>只改位置層級，不進完整編輯器。</span>
                        </div>
                        <div className="quick-move-grid">
                          <label>
                            <span>區域</span>
                            <select value={quickMoveDraft.area} onChange={handleQuickMovePlacementChange('area')}>
                              <option value="">請選擇區域</option>
                              {quickMoveAreaOptions.map((area) => (
                                <option key={area} value={area}>
                                  {area}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>位置</span>
                            <select value={quickMoveDraft.location} onChange={handleQuickMovePlacementChange('location')}>
                              <option value="">請選擇位置</option>
                              {quickMoveLocationOptions.map((location) => (
                                <option key={location} value={location}>
                                  {location}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>大類</span>
                            <select
                              value={quickMoveDraft.parentLabel}
                              onChange={handleQuickMovePlacementChange('parentLabel')}
                            >
                              <option value="">請選擇大類</option>
                              {quickMoveParentOptions.map((parentLabel) => (
                                <option key={parentLabel} value={parentLabel}>
                                  {parentLabel}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>子類</span>
                            <select
                              value={quickMoveDraft.childLabel}
                              onChange={handleQuickMovePlacementChange('childLabel')}
                            >
                              <option value="">請選擇子類</option>
                              {quickMoveChildOptions.map((childLabel) => (
                                <option key={childLabel} value={childLabel}>
                                  {childLabel}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="quick-move-actions">
                          <button type="button" onClick={() => void saveQuickMove(item, 'active')} disabled={isSaving}>
                            {isSaving ? '儲存中...' : '儲存搬移'}
                          </button>
                          <button type="button" className="ghost-inline" onClick={cancelQuickMove} disabled={isSaving}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>

          <section className="results-panel staging-panel">
            <div className="panel-heading">
              <h2>暫存區</h2>
              <span>{filteredStagingItems.length} 筆待決定</span>
            </div>

            {filteredStagingItems.length === 0 ? (
              <div className="empty-state">
                <h3>暫存區目前是空的</h3>
                <p>新進物品先放這裡，再用一鍵提示詞交給高階 LLM 做評分與建議。</p>
              </div>
            ) : (
              <div className="results-list">
                {filteredStagingItems.map((item: EnrichedItem) => (
                  <article key={item.id} className="result-card staging-card">
                    <div className="result-header">
                      <div>
                        <h3>{highlightText(item.name, query)}</h3>
                        <p>{highlightText(item.path, query)}</p>
                      </div>
                      <div className="card-actions">
                        <button type="button" className="copy-button" onClick={() => void copyStagingItemPrompt(item)}>
                          複製提問片段
                        </button>
                        {isLoggedIn ? (
                          <>
                            <button type="button" className="ghost-inline" onClick={() => startQuickMove(item)}>
                              {quickMoveItemId === item.id ? '收起定位' : '快速定位'}
                            </button>
                            <button type="button" className="ghost-inline" onClick={() => startEdit(item)}>
                              編輯暫存
                            </button>
                            <button type="button" className="ghost-inline" onClick={() => void promoteStagingItem(item)}>
                              直接歸檔
                            </button>
                            <button type="button" className="danger-inline" onClick={() => void deleteItem(item)}>
                              刪除
                            </button>
                          </>
                        ) : null}
                      </div>
                    </div>

                    <div className="tag-row">
                      <span>暫存區</span>
                      {item.area ? <span>候選區域：{item.area}</span> : null}
                      {item.location ? <span>候選位置：{item.location}</span> : null}
                    </div>

                    <p className="reason">
                      <strong>暫存說明：</strong>
                      {item.stagingNote || '尚未填寫'}
                    </p>
                    <p className="reason">
                      <strong>LLM 建議：</strong>
                      {item.llmSuggestion || '尚未填寫'}
                    </p>
                    <p className="reason">
                      <strong>背景備註：</strong>
                      {item.reason || '尚未填寫'}
                    </p>

                    {isLoggedIn && quickMoveItemId === item.id ? (
                      <div className="quick-move-panel">
                        <div className="quick-move-heading">
                          <strong>快速定位</strong>
                          <span>先存候選位置，或直接定位後歸檔。</span>
                        </div>
                        <div className="quick-move-grid">
                          <label>
                            <span>區域</span>
                            <select value={quickMoveDraft.area} onChange={handleQuickMovePlacementChange('area')}>
                              <option value="">尚未決定</option>
                              {quickMoveAreaOptions.map((area) => (
                                <option key={area} value={area}>
                                  {area}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>位置</span>
                            <select value={quickMoveDraft.location} onChange={handleQuickMovePlacementChange('location')}>
                              <option value="">尚未決定</option>
                              {quickMoveLocationOptions.map((location) => (
                                <option key={location} value={location}>
                                  {location}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>大類</span>
                            <select
                              value={quickMoveDraft.parentLabel}
                              onChange={handleQuickMovePlacementChange('parentLabel')}
                            >
                              <option value="">尚未決定</option>
                              {quickMoveParentOptions.map((parentLabel) => (
                                <option key={parentLabel} value={parentLabel}>
                                  {parentLabel}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label>
                            <span>子類</span>
                            <select
                              value={quickMoveDraft.childLabel}
                              onChange={handleQuickMovePlacementChange('childLabel')}
                            >
                              <option value="">尚未決定</option>
                              {quickMoveChildOptions.map((childLabel) => (
                                <option key={childLabel} value={childLabel}>
                                  {childLabel}
                                </option>
                              ))}
                            </select>
                          </label>
                        </div>
                        <div className="quick-move-actions">
                          <button type="button" onClick={() => void saveQuickMove(item, 'staging')} disabled={isSaving}>
                            {isSaving ? '儲存中...' : '儲存候選'}
                          </button>
                          <button type="button" onClick={() => void saveQuickMove(item, 'active')} disabled={isSaving}>
                            {isSaving ? '儲存中...' : '定位後歸檔'}
                          </button>
                          <button type="button" className="ghost-inline" onClick={cancelQuickMove} disabled={isSaving}>
                            取消
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </section>
        </section>
      </section>
    </main>
  )
}

export default App
