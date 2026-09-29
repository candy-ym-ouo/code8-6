<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ApiError } from '../api/client';
import { booksApi, reflectionApi, traceApi } from '../api';
import { formatDate, formatDateTime } from '../api/format';
import ErrorNotice from '../components/ErrorNotice.vue';
import MoodPicker from '../components/MoodPicker.vue';
import {
  ACTION_LABELS,
  ENTITY_LABELS,
  MOOD_LABELS,
  STATUS_LABELS,
  TRACE_LABELS,
  type Book,
  type BookStatus,
  type MoodTag,
  type Reflection,
  type RereadMark,
  type Trace,
  type TraceType
} from '../types/domain';
import { timelineApi } from '../api';
import {
  aggregateRereadMarks,
  distinctRereadReasons,
  EMPTY_REASON,
  fetchAllPages,
  filterRereadGroups
} from '../lib/traces';

type DeletedItem = { kind: 'DOG_EAR' | 'ANNOTATION' | 'REREAD_MARK' | 'REFLECTION'; id: string; label: string };
type ReflectionEdit = { id: string; version: number; moodTags: MoodTag[]; text: string };

const route = useRoute();
const router = useRouter();
const bookId = computed(() => String(route.params.bookId));
const book = ref<Book | null>(null);
const bookView = computed(() => book.value as Book);
const traces = ref<Trace[]>([]);
const reflections = ref<Reflection[]>([]);
const activities = ref<Array<{ id: string; action: keyof typeof ACTION_LABELS; entityType: keyof typeof ENTITY_LABELS; payload: Record<string, unknown>; occurredAt: string }>>([]);
const loading = ref(true);
const saving = ref(false);
const error = ref('');
const success = ref('');
const activeTab = ref<'PAGES' | TraceType | 'REFLECTIONS' | 'TIMELINE'>('PAGES');
const createType = ref<TraceType | null>(null);
const editing = ref<Trace | null>(null);
const rereadReasonFilter = ref('');
const showCompleteForm = ref(false);
const reflectionEdit = ref<ReflectionEdit | null>(null);
const lastDeleted = ref<DeletedItem | null>(null);
const traceForm = reactive({
  pageNumber: '',
  reason: '',
  startPage: '',
  endPage: '',
  content: ''
});
const completeForm = reactive({
  moodTags: [] as MoodTag[],
  text: ''
});

const tabs = computed(() => [
  { value: 'PAGES' as const, label: '按页' },
  { value: 'DOG_EAR' as const, label: `折角 ${book.value?.traceSummary.dogEars ?? 0}` },
  { value: 'ANNOTATION' as const, label: `批注 ${book.value?.traceSummary.annotations ?? 0}` },
  { value: 'REREAD_MARK' as const, label: `重读 ${book.value?.traceSummary.rereadMarks ?? 0}` },
  { value: 'REFLECTIONS' as const, label: `读完感受 ${reflections.value.length}` },
  { value: 'TIMELINE' as const, label: '本书时间线' }
]);

const rereadMarks = computed<RereadMark[]>(() =>
  traces.value.filter((trace): trace is RereadMark => trace.type === 'REREAD_MARK')
);

const rereadReasonOptions = computed(() => distinctRereadReasons(rereadMarks.value));

const hasEmptyRereadReason = computed(() => rereadMarks.value.some((mark) => !mark.reason));

// 轮次取后端页内序号按页聚合，再叠加原因筛选，筛选与全量视图的编号一致。
const rereadGroups = computed(() =>
  filterRereadGroups(aggregateRereadMarks(rereadMarks.value), rereadReasonFilter.value)
);

const filteredRereadCount = computed(() =>
  rereadGroups.value.reduce((sum, group) => sum + group.marks.length, 0)
);

const visibleTraces = computed(() => {
  const filtered =
    activeTab.value === 'PAGES'
      ? traces.value
      : traces.value.filter((trace) => trace.type === activeTab.value);
  return [...filtered].sort((a, b) => tracePage(a) - tracePage(b) || b.createdAt.localeCompare(a.createdAt));
});

const statusActions = computed(() => {
  if (!book.value) return [];
  const actions: Array<{ status: BookStatus; label: string }> = [];
  if (book.value.status === 'TO_READ') {
    actions.push({ status: 'READING', label: '开始阅读' }, { status: 'ABANDONED', label: '停止阅读' });
  } else if (book.value.status === 'READING') {
    actions.push({ status: 'PAUSED', label: '暂时搁置' }, { status: 'READ', label: '标记为读完' }, { status: 'ABANDONED', label: '停止阅读' });
  } else if (book.value.status === 'PAUSED') {
    actions.push({ status: 'READING', label: '继续阅读' }, { status: 'READ', label: '标记为读完' }, { status: 'ABANDONED', label: '停止阅读' });
  } else if (book.value.status === 'READ') {
    actions.push({ status: 'READING', label: '重新阅读' });
  }
  return actions;
});

function tracePage(trace: Trace): number {
  return trace.type === 'ANNOTATION' ? trace.startPage : trace.pageNumber;
}

function traceRange(trace: Trace): string {
  if (trace.type === 'ANNOTATION') {
    return trace.startPage === trace.endPage ? `第 ${trace.startPage} 页` : `第 ${trace.startPage}–${trace.endPage} 页`;
  }
  return `第 ${trace.pageNumber} 页`;
}

function traceBody(trace: Trace): string {
  return trace.type === 'ANNOTATION' ? trace.content : trace.reason || '未填写原因';
}

function canEditReflection(reflection: Reflection): boolean {
  return new Date(reflection.editableUntil).getTime() >= Date.now();
}

async function loadAllTraces(id: string): Promise<Trace[]> {
  // 按 id 去重的全量拉取：翻页期间若列表有新增，相邻页会重复一行，
  // 去重后继续翻到唯一数量达到最新 total，避免把新记录漏在页边界外。
  return fetchAllPages<Trace>((page, pageSize) =>
    booksApi.traces(id, new URLSearchParams({ page: String(page), pageSize: String(pageSize) }))
  );
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const [bookResult, loadedTraces, reflectionResult, timelineResult] = await Promise.all([
      booksApi.get(bookId.value),
      loadAllTraces(bookId.value),
      booksApi.reflections(bookId.value),
      timelineApi.list(new URLSearchParams({ bookId: bookId.value, pageSize: '100' }))
    ]);
    book.value = bookResult.book;
    traces.value = loadedTraces;
    reflections.value = reflectionResult.items;
    activities.value = timelineResult.items;
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '书目加载失败';
  } finally {
    loading.value = false;
  }
}

function resetTraceForm(): void {
  traceForm.pageNumber = '';
  traceForm.reason = '';
  traceForm.startPage = '';
  traceForm.endPage = '';
  traceForm.content = '';
}

function openCreate(type: TraceType): void {
  createType.value = type;
  editing.value = null;
  resetTraceForm();
  error.value = '';
}

function openEdit(trace: Trace): void {
  createType.value = null;
  editing.value = trace;
  resetTraceForm();
  if (trace.type === 'ANNOTATION') {
    traceForm.startPage = String(trace.startPage);
    traceForm.endPage = String(trace.endPage);
    traceForm.content = trace.content;
  } else {
    traceForm.pageNumber = String(trace.pageNumber);
    traceForm.reason = trace.reason ?? '';
  }
  error.value = '';
}

async function submitTrace(): Promise<void> {
  if (!book.value) return;
  if (!editing.value && !createType.value) return;
  saving.value = true;
  error.value = '';
  try {
    if (createType.value === 'DOG_EAR') {
      await traceApi.createDogEar(book.value.id, {
        pageNumber: Number(traceForm.pageNumber),
        reason: traceForm.reason.trim() || null
      });
    } else if (createType.value === 'ANNOTATION') {
      await traceApi.createAnnotation(book.value.id, {
        startPage: Number(traceForm.startPage),
        endPage: Number(traceForm.endPage || traceForm.startPage),
        content: traceForm.content
      });
    } else if (createType.value === 'REREAD_MARK') {
      await traceApi.createReread(book.value.id, {
        pageNumber: Number(traceForm.pageNumber),
        reason: traceForm.reason.trim() || null
      });
    } else if (editing.value?.type === 'DOG_EAR') {
      await traceApi.updateDogEar(editing.value.id, {
        pageNumber: Number(traceForm.pageNumber),
        reason: traceForm.reason.trim() || null,
        version: editing.value.version
      });
    } else if (editing.value?.type === 'ANNOTATION') {
      await traceApi.updateAnnotation(editing.value.id, {
        startPage: Number(traceForm.startPage),
        endPage: Number(traceForm.endPage || traceForm.startPage),
        content: traceForm.content,
        version: editing.value.version
      });
    } else if (editing.value?.type === 'REREAD_MARK') {
      await traceApi.updateReread(editing.value.id, {
        pageNumber: Number(traceForm.pageNumber),
        reason: traceForm.reason.trim() || null,
        version: editing.value.version
      });
    }
    createType.value = null;
    editing.value = null;
    success.value = '阅读痕迹已保存';
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '保存失败，请检查输入';
  } finally {
    saving.value = false;
  }
}

async function deleteTrace(trace: Trace): Promise<void> {
  if (!window.confirm(`确定删除${TRACE_LABELS[trace.type]}「${traceRange(trace)}」吗？24 小时内可以撤销。`)) return;
  error.value = '';
  try {
    if (trace.type === 'DOG_EAR') await traceApi.deleteDogEar(trace.id, trace.version);
    if (trace.type === 'ANNOTATION') await traceApi.deleteAnnotation(trace.id, trace.version);
    if (trace.type === 'REREAD_MARK') await traceApi.deleteReread(trace.id, trace.version);
    lastDeleted.value = { kind: trace.type, id: trace.id, label: `${TRACE_LABELS[trace.type]} ${traceRange(trace)}` };
    success.value = '已删除，可在 24 小时内撤销';
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '删除失败';
  }
}

async function restoreLastDeleted(): Promise<void> {
  if (!lastDeleted.value) return;
  error.value = '';
  try {
    const item = lastDeleted.value;
    if (item.kind === 'DOG_EAR') await traceApi.restoreDogEar(item.id);
    if (item.kind === 'ANNOTATION') await traceApi.restoreAnnotation(item.id);
    if (item.kind === 'REREAD_MARK') await traceApi.restoreReread(item.id);
    if (item.kind === 'REFLECTION') await reflectionApi.restore(item.id);
    lastDeleted.value = null;
    success.value = '删除已撤销';
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '恢复失败';
  }
}

async function changeStatus(status: BookStatus): Promise<void> {
  if (!book.value) return;
  if (status === 'READ') {
    completeForm.moodTags = [];
    completeForm.text = '';
    showCompleteForm.value = true;
    return;
  }
  if (!window.confirm(`将「${book.value.title}」的状态改为“${STATUS_LABELS[status]}”？`)) return;
  saving.value = true;
  error.value = '';
  try {
    const result = await booksApi.updateStatus(book.value.id, { status, version: book.value.version });
    book.value = { ...book.value, ...result.book, traceSummary: book.value.traceSummary };
    success.value = '书目状态已更新';
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '状态更新失败';
  } finally {
    saving.value = false;
  }
}

async function completeBook(): Promise<void> {
  if (!book.value) return;
  if (completeForm.moodTags.length === 0) {
    error.value = '请至少选择一个读完后的情绪';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    await booksApi.updateStatus(book.value.id, {
      status: 'READ',
      version: book.value.version,
      reflection: { moodTags: completeForm.moodTags, text: completeForm.text }
    });
    showCompleteForm.value = false;
    success.value = '这本书的完成感受已保存';
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '完成感受保存失败';
  } finally {
    saving.value = false;
  }
}

function openReflectionEdit(reflection: Reflection): void {
  reflectionEdit.value = {
    id: reflection.id,
    version: reflection.version,
    moodTags: [...reflection.moodTags],
    text: reflection.text
  };
}

async function saveReflection(): Promise<void> {
  if (!reflectionEdit.value) return;
  if (reflectionEdit.value.moodTags.length === 0) {
    error.value = '请至少选择一个情绪';
    return;
  }
  saving.value = true;
  error.value = '';
  try {
    await reflectionApi.update(reflectionEdit.value.id, {
      moodTags: reflectionEdit.value.moodTags,
      text: reflectionEdit.value.text,
      version: reflectionEdit.value.version
    });
    reflectionEdit.value = null;
    success.value = '完成感受已修订，旧版本仍保留在时间线中';
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '修订失败';
  } finally {
    saving.value = false;
  }
}

async function deleteReflection(reflection: Reflection): Promise<void> {
  if (!window.confirm('删除这次完成感受后，书目会回到“阅读中”。确定继续吗？')) return;
  try {
    await reflectionApi.delete(reflection.id, reflection.version);
    lastDeleted.value = { kind: 'REFLECTION', id: reflection.id, label: `第 ${reflection.completionRound} 次读完感受` };
    success.value = '完成感受已删除，可撤销';
    await load();
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '删除失败';
  }
}

async function deleteBook(): Promise<void> {
  if (!book.value) return;
  if (!window.confirm(`确定删除《${book.value.title}》及其全部阅读痕迹吗？此操作不可从界面撤销。`)) return;
  try {
    await booksApi.delete(book.value.id, book.value.version);
    await router.push('/');
  } catch (caught) {
    error.value = caught instanceof ApiError ? caught.message : '删除书目失败';
  }
}

function eventSummary(payload: Record<string, unknown>): string {
  if (typeof payload.pageNumber === 'number') return `第 ${payload.pageNumber} 页`;
  if (typeof payload.startPage === 'number') {
    const end = typeof payload.endPage === 'number' ? payload.endPage : payload.startPage;
    return `第 ${payload.startPage}–${end} 页`;
  }
  if (Array.isArray(payload.moodTags)) return payload.moodTags.map((tag) => MOOD_LABELS[tag as MoodTag] ?? tag).join('、');
  if (payload.cascade) return '随书目删除';
  return '';
}

onMounted(load);
</script>

<template>
  <section v-if="loading" class="state-panel">正在读取书页之间的痕迹…</section>
  <section v-else-if="book">
    <header class="detail-heading">
      <div class="detail-title">
        <div v-if="bookView.coverUrl" class="detail-cover-wrap">
          <img class="detail-cover" :src="bookView.coverUrl" :alt="`${bookView.title} 封面`" referrerpolicy="no-referrer" />
        </div>
        <div>
          <p class="eyebrow">BOOK TRACES</p>
          <span class="status-badge" :data-status="bookView.status">{{ STATUS_LABELS[bookView.status] }}</span>
          <h1>{{ bookView.title }}</h1>
          <p class="muted">{{ [bookView.author || '作者未填写', bookView.publisher, bookView.publicationYear].filter(Boolean).join(' · ') }}</p>
          <p class="muted">总页数：{{ bookView.pageCount ?? '未填写' }} · ISBN：{{ bookView.isbn || '未填写' }}</p>
        </div>
      </div>
      <div class="heading-actions">
        <RouterLink class="button" :to="`/books/${bookView.id}/edit`">编辑书目</RouterLink>
        <button class="button button-danger-quiet" type="button" @click="deleteBook">删除书目</button>
      </div>
    </header>

    <ErrorNotice :message="error" />
    <div v-if="success" class="success-notice" role="status">
      {{ success }}
      <button v-if="lastDeleted" class="text-button" type="button" @click="restoreLastDeleted">
        撤销删除「{{ lastDeleted.label }}」
      </button>
    </div>

    <section class="card status-panel">
      <div>
        <h2>阅读状态</h2>
        <p class="muted">状态只表示书与你的关系，不计算阅读进度或速度。</p>
      </div>
      <div class="button-row">
        <button
          v-for="action in statusActions"
          :key="action.status"
          class="button"
          :class="{ 'button-primary': action.status === 'READ' }"
          type="button"
          :disabled="saving"
          @click="changeStatus(action.status)"
        >
          {{ action.label }}
        </button>
        <span v-if="statusActions.length === 0" class="muted">当前状态没有可执行的后续操作</span>
      </div>
    </section>

    <form v-if="showCompleteForm" class="card completion-form" @submit.prevent="completeBook">
      <div class="section-heading">
        <div>
          <p class="eyebrow">FINISHED</p>
          <h2>读完《{{ bookView.title }}》时</h2>
        </div>
        <button class="button button-quiet" type="button" @click="showCompleteForm = false">取消</button>
      </div>
      <MoodPicker v-model="completeForm.moodTags" />
      <label>
        想留下的话（可选）
        <textarea v-model="completeForm.text" rows="5" maxlength="5000" placeholder="不写摘要，只写此刻与你有关的感受。" />
      </label>
      <button class="button button-primary" type="submit" :disabled="saving">保存完成感受</button>
    </form>

    <section class="card trace-workspace">
      <div class="section-heading">
        <div>
          <h2>阅读痕迹</h2>
          <p class="muted">折角、批注和重读页都只以页码定位，不形成进度。</p>
        </div>
        <div class="button-row">
          <button class="button" type="button" @click="openCreate('DOG_EAR')">记一次折角</button>
          <button class="button" type="button" @click="openCreate('ANNOTATION')">写批注</button>
          <button class="button" type="button" @click="openCreate('REREAD_MARK')">标记重读页</button>
        </div>
      </div>

      <form v-if="createType || editing" class="inline-editor" @submit.prevent="submitTrace">
        <h3>
          {{ editing ? `编辑${TRACE_LABELS[editing.type]}` : `新增${TRACE_LABELS[createType!]}` }}
        </h3>
        <template v-if="createType === 'ANNOTATION' || editing?.type === 'ANNOTATION'">
          <div class="form-grid compact-grid">
            <label>起始页<input v-model="traceForm.startPage" type="number" min="1" required /></label>
            <label>结束页<input v-model="traceForm.endPage" type="number" min="1" placeholder="单页可留空" /></label>
          </div>
          <label>批注<textarea v-model="traceForm.content" rows="5" maxlength="5000" required /></label>
        </template>
        <template v-else>
          <label>页码<input v-model="traceForm.pageNumber" type="number" min="1" required /></label>
          <label>
            {{ createType === 'DOG_EAR' || editing?.type === 'DOG_EAR' ? '折角原因（可选）' : '为什么重读这一页（可选）' }}
            <textarea
              v-model="traceForm.reason"
              rows="3"
              :maxlength="createType === 'REREAD_MARK' || editing?.type === 'REREAD_MARK' ? 1000 : 500"
            />
          </label>
        </template>
        <div class="form-actions">
          <button class="button button-quiet" type="button" @click="createType = null; editing = null">取消</button>
          <button class="button button-primary" type="submit" :disabled="saving">保存痕迹</button>
        </div>
      </form>

      <div class="tabs" role="tablist">
        <button
          v-for="tab in tabs"
          :key="tab.value"
          class="tab"
          :class="{ active: activeTab === tab.value }"
          type="button"
          role="tab"
          :aria-selected="activeTab === tab.value"
          @click="activeTab = tab.value"
        >
          {{ tab.label }}
        </button>
      </div>

      <div v-if="activeTab === 'REFLECTIONS'" class="trace-list">
        <article v-for="reflection in reflections" :key="reflection.id" class="trace-card">
          <div class="trace-card-heading">
            <div>
              <span class="trace-type">第 {{ reflection.completionRound }} 次读完</span>
              <strong>{{ formatDate(reflection.completedAt) }}</strong>
            </div>
            <div v-if="canEditReflection(reflection)" class="button-row">
              <button class="text-button" type="button" @click="openReflectionEdit(reflection)">修订</button>
              <button class="text-button danger-text" type="button" @click="deleteReflection(reflection)">删除</button>
            </div>
          </div>
          <div class="mood-list">
            <span v-for="tag in reflection.moodTags" :key="tag" class="mood-chip selected">{{ MOOD_LABELS[tag] }}</span>
          </div>
          <p class="preserve-text">{{ reflection.text || '当时没有写下更多文字。' }}</p>
          <p class="muted">可编辑至 {{ formatDateTime(reflection.editableUntil) }}</p>
          <form v-if="reflectionEdit?.id === reflection.id" class="inline-editor" @submit.prevent="saveReflection">
            <MoodPicker v-model="reflectionEdit.moodTags" />
            <label>感受<textarea v-model="reflectionEdit.text" rows="4" maxlength="5000" /></label>
            <div class="form-actions">
              <button class="button button-quiet" type="button" @click="reflectionEdit = null">取消</button>
              <button class="button button-primary" type="submit" :disabled="saving">保存修订</button>
            </div>
          </form>
        </article>
        <p v-if="reflections.length === 0" class="empty-inline">还没有读完后留下的感受。</p>
      </div>

      <div v-else-if="activeTab === 'TIMELINE'" class="timeline-list">
        <article v-for="event in activities" :key="event.id" class="timeline-item">
          <span class="timeline-dot" aria-hidden="true" />
          <div>
            <strong>{{ ACTION_LABELS[event.action] }}{{ ENTITY_LABELS[event.entityType] }}</strong>
            <p>{{ eventSummary(event.payload) || '记录随时间更新' }}</p>
            <time :datetime="event.occurredAt">{{ formatDateTime(event.occurredAt) }}</time>
          </div>
        </article>
        <p v-if="activities.length === 0" class="empty-inline">这本书还没有变化记录。</p>
      </div>

      <div v-else-if="activeTab === 'REREAD_MARK'" class="reread-workspace">
        <form class="reread-filter" @submit.prevent>
          <label>
            重读原因
            <select v-model="rereadReasonFilter">
              <option value="">全部原因</option>
              <option v-if="hasEmptyRereadReason" :value="EMPTY_REASON">未填写原因</option>
              <option v-for="reason in rereadReasonOptions" :key="reason" :value="reason">{{ reason }}</option>
            </select>
          </label>
          <p class="muted reread-filter-count">
            共 {{ filteredRereadCount }} 条重读 · {{ rereadGroups.length }} 个页面
          </p>
        </form>

        <div v-if="rereadGroups.length > 0" class="reread-group-list">
          <section v-for="group in rereadGroups" :key="group.pageNumber" class="reread-group">
            <h3 class="reread-group-title">
              第 {{ group.pageNumber }} 页
              <span class="muted">· 共重读 {{ group.marks.length }} 次</span>
            </h3>
            <div class="trace-list">
              <article v-for="mark in group.marks" :key="`REREAD_MARK-${mark.id}`" class="trace-card">
                <div class="trace-card-heading">
                  <div>
                    <span class="trace-type">第 {{ mark.round }} 次重读</span>
                    <strong>第 {{ mark.pageNumber }} 页</strong>
                  </div>
                  <div class="button-row">
                    <button class="text-button" type="button" @click="openEdit(mark)">编辑</button>
                    <button class="text-button danger-text" type="button" @click="deleteTrace(mark)">删除</button>
                  </div>
                </div>
                <p class="preserve-text">{{ mark.reason || '未填写原因' }}</p>
                <p class="muted">创建 {{ formatDateTime(mark.createdAt) }} · 更新 {{ formatDateTime(mark.updatedAt) }}</p>
              </article>
            </div>
          </section>
        </div>
        <p v-else class="empty-inline">
          {{ rereadReasonFilter ? '没有符合该原因的重读记录。' : '这个分类还没有留下痕迹。' }}
        </p>
      </div>

      <div v-else class="trace-list">
        <article v-for="trace in visibleTraces" :key="`${trace.type}-${trace.id}`" class="trace-card">
          <div class="trace-card-heading">
            <div>
              <span class="trace-type">{{ TRACE_LABELS[trace.type] }}</span>
              <strong>{{ traceRange(trace) }}</strong>
            </div>
            <div class="button-row">
              <button class="text-button" type="button" @click="openEdit(trace)">编辑</button>
              <button class="text-button danger-text" type="button" @click="deleteTrace(trace)">删除</button>
            </div>
          </div>
          <p class="preserve-text">{{ traceBody(trace) }}</p>
          <p class="muted">创建 {{ formatDateTime(trace.createdAt) }} · 更新 {{ formatDateTime(trace.updatedAt) }}</p>
        </article>
        <p v-if="visibleTraces.length === 0" class="empty-inline">这个分类还没有留下痕迹。</p>
      </div>
    </section>
  </section>
  <section v-else class="empty-state card">
    <h1>书目不可用</h1>
    <ErrorNotice :message="error" />
    <RouterLink class="button button-primary" to="/">返回我的书</RouterLink>
  </section>
</template>
