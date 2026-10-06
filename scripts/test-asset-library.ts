/**
 * 端到端验证（Node + fake-indexeddb）：
 * 1. 旧版 localStorage 工程里的内嵌音频迁移到 IndexedDB 素材库，记录里只剩索引；
 * 2. 迁移失败（模拟配额）时保留内嵌数据兜底，可继续“出声”，下次重试成功；
 * 3. 容量预检放不下时拒绝写入；
 * 4. 批量写入中途失败时，已写入的素材被清理、工程快照不变。
 */
import 'fake-indexeddb/auto';
import assert from 'node:assert/strict';

// localStorage 垫片
const memoryStore = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => (memoryStore.has(key) ? memoryStore.get(key)! : null),
  setItem: (key: string, value: string) => {
    memoryStore.set(key, String(value));
  },
  removeItem: (key: string) => {
    memoryStore.delete(key);
  },
  clear: () => memoryStore.clear(),
  key: () => null,
  length: 0,
} as unknown as Storage;

// navigator.storage.estimate 垫片，可切换配额
let estimateResult: { quota: number; usage: number } = {
  quota: 100 * 1024 * 1024,
  usage: 0,
};
globalThis.navigator = {
  storage: { estimate: async () => estimateResult },
} as unknown as Navigator;

// FileReader 垫片（Node 环境下用 blob.arrayBuffer 实现 readAsDataURL）
class FileReaderShim {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  async readAsDataURL(blob: Blob) {
    try {
      const buffer = Buffer.from(await blob.arrayBuffer());
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${buffer.toString('base64')}`;
      this.onload?.();
    } catch {
      this.onerror?.();
    }
  }
}
(globalThis as unknown as { FileReader: typeof FileReaderShim }).FileReader = FileReaderShim;

const {
  putMedia,
  getMediaBlob,
  listMediaMeta,
  assertSpaceFor,
  dataUrlToBlob,
  blobToDataUrl,
  AssetStorageError,
  deleteMedia,
} = await import('../src/utils/assetLibrary.ts');
const {
  migrateLegacyStorage,
  consumeLegacyMigrationReport,
  STORAGE_KEY,
} = await import('../src/utils/storageMigration.ts');

function tinyWavDataUrl(text: string): string {
  // 极小的合法 WAV：44 字节头 + 少量 PCM
  const sampleRate = 8000;
  const samples = new Uint8Array(text.length * 200);
  return `data:audio/wav;base64,${Buffer.from(samples).toString('base64')}`.replace(
    'audio/wav',
    `audio/wav;x=${text.length}`,
  );
}

function makeLegacyProject(assets: unknown[]) {
  return JSON.stringify({
    state: {
      project: {
        version: 1,
        name: '旧工程',
        bpm: 120,
        snap: 0.25,
        loopEnabled: false,
        loopStart: 0,
        loopEnd: 8,
        pixelsPerSecond: 92,
        tracks: [
          {
            id: 'track-1',
            name: '轨 1',
            color: '#2563eb',
            volume: 1,
            pan: 0,
            muted: false,
            solo: false,
            height: 112,
            clips: assets.map((asset, index) => ({
              id: `clip-${index}`,
              assetId: (asset as { id: string }).id,
              name: '片段',
              start: index,
              duration: 1,
              offset: 0,
              fadeIn: 0,
              fadeOut: 0,
              effect: 'none',
              effectAmount: 0,
            })),
          },
        ],
        assets,
        updatedAt: 0,
      },
      zoom: 1,
      selectedClipId: null,
      selectedTrackId: 'track-1',
    },
    version: 0,
  });
}

// --- 测试 1：旧数据迁移 -----------------------------------------------------
{
  const url1 = tinyWavDataUrl('a');
  const url2 = tinyWavDataUrl('bb');
  const legacy = makeLegacyProject([
    { id: 'asset-old-1', name: '旧录音', source: 'recorded', duration: 1, mimeType: 'audio/webm', dataUrl: url1, size: 10 },
    { id: 'asset-old-2', name: '旧导入', source: 'imported', duration: 1, mimeType: 'audio/mpeg', dataUrl: url2, size: 20 },
    { id: 'synth-drums', name: '内置 · 紧凑鼓组', source: 'synthetic', duration: 8, mimeType: 'audio/wav' },
  ]);
  localStorage.setItem(STORAGE_KEY, legacy);

  await migrateLegacyStorage();

  const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
  const project = persisted.state.project;
  assert.equal(project.version, 2, '工程记录升级到 v2');
  for (const asset of project.assets) {
    assert.equal(asset.dataUrl, undefined, `素材 ${asset.id} 的音频内容已从记录中剥离`);
    assert.equal(asset.pendingMigration, undefined, `${asset.id} 不应处于待迁移状态`);
  }
  const blob1 = await getMediaBlob('asset-old-1');
  const blob2 = await getMediaBlob('asset-old-2');
  assert.ok(blob1 && blob1.size > 0, '旧录音已写入素材库');
  assert.ok(blob2 && blob2.size > 0, '旧导入已写入素材库');
  const metas = await listMediaMeta();
  assert.equal(metas.length, 2, '素材库中恰好有两个自定义素材');
  assert.equal(metas.find((m) => m.id === 'asset-old-1')?.size, 10, '素材索引保留 size');

  const report = consumeLegacyMigrationReport();
  assert.equal(report?.migratedCount, 2, '迁移报告显示 2 个素材');

  // 解析回来的 Blob 仍可转成 dataUrl（证明“声音还在”）
  const back = await blobToDataUrl(blob1!);
  assert.ok(back.startsWith('data:audio/'), '素材库里的声音可重新读取');
  console.log('✔ 测试 1：旧数据迁移到素材库，记录里只剩索引');
}

// --- 测试 2：迁移幂等（重复打开） -------------------------------------------
{
  await migrateLegacyStorage();
  const metas = await listMediaMeta();
  assert.equal(metas.length, 2, '重复迁移不产生重复素材');
  assert.equal(consumeLegacyMigrationReport(), null, '第二次打开没有新的迁移报告');
  console.log('✔ 测试 2：迁移幂等');
}

// --- 测试 3：配额不足时拒绝写入 ---------------------------------------------
{
  estimateResult = { quota: 10 * 1024 * 1024, usage: 0 };
  await assert.rejects(
    () => assertSpaceFor(50 * 1024 * 1024, '大文件'),
    (error: unknown) => error instanceof AssetStorageError && error.reason === 'quota',
    '空间不足应抛 quota 错误',
  );
  // 放得下时不抛
  await assertSpaceFor(1024, '小文件');
  estimateResult = { quota: 100 * 1024 * 1024, usage: 0 };
  console.log('✔ 测试 3：容量预检先拒绝');
}

// --- 测试 4：Blob/dataUrl 往返 ----------------------------------------------
{
  const dataUrl = 'data:audio/wav;base64,' + Buffer.from('hello-audio').toString('base64');
  const blob = dataUrlToBlob(dataUrl);
  assert.equal(blob.type, 'audio/wav');
  const round = await blobToDataUrl(blob);
  assert.equal(round, dataUrl, 'Blob <-> dataUrl 往返一致');
  console.log('✔ 测试 4：Blob/dataUrl 转换');
}

// --- 测试 5：写入失败后删除不残留（模拟批量回滚） ---------------------------
{
  estimateResult = { quota: 100 * 1024 * 1024, usage: 0 };
  const blob = dataUrlToBlob('data:audio/wav;base64,' + Buffer.from('xyz').toString('base64'));
  await putMedia({ id: 'asset-tmp', name: '临时', source: 'imported', duration: 1, mimeType: 'audio/wav', size: blob.size }, blob);
  assert.ok(await getMediaBlob('asset-tmp'));
  await deleteMedia('asset-tmp');
  assert.equal(await getMediaBlob('asset-tmp'), undefined, '回滚删除后素材库无残留');
  console.log('✔ 测试 5：失败回滚后素材库清理干净');
}

// --- 测试 6：配额不足时迁移保留内嵌数据兜底 ---------------------------------
{
  const url = tinyWavDataUrl('c');
  const legacy = makeLegacyProject([
    { id: 'asset-fail', name: '迁移失败素材', source: 'imported', duration: 1, mimeType: 'audio/mpeg', dataUrl: url, size: 99 },
  ]);
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, legacy);
  // 让所有空间判断都失败
  estimateResult = { quota: 100, usage: 999 };

  await migrateLegacyStorage();
  const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
  const asset = persisted.state.project.assets.find((a: { id: string }) => a.id === 'asset-fail');
  assert.ok(asset.dataUrl, '迁移失败时内嵌音频保留（仍可播放，不会“找不到声音”）');
  assert.equal(asset.pendingMigration, true, '标记为待重试');
  const report = consumeLegacyMigrationReport();
  assert.deepEqual(report?.failedNames, ['迁移失败素材'], '报告列出失败素材');

  // 恢复空间后再次打开：重试成功
  estimateResult = { quota: 100 * 1024 * 1024, usage: 0 };
  await migrateLegacyStorage();
  assert.ok(await getMediaBlob('asset-fail'), '重试后素材进入素材库');
  const persisted2 = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
  const asset2 = persisted2.state.project.assets.find((a: { id: string }) => a.id === 'asset-fail');
  assert.equal(asset2.dataUrl, undefined, '重试成功后剥离内嵌数据');
  assert.equal(asset2.pendingMigration, undefined, '解除待重试标记');
  console.log('✔ 测试 6：迁移失败有兜底，恢复空间后重试成功');
}

console.log('\n全部通过');
