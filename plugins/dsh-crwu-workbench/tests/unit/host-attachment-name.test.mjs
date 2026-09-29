import assert from 'node:assert/strict'
import test from 'node:test'

/**
 * 附件的稳定本地名（`host/h3yun/attachment-name.ts`）。
 *
 * 这一份钉的是「两个同名附件不许互相覆盖」的**判据本身**：名字必须只由 `fileId` 决定
 * （与下载顺序无关），外部文件名必须先被收敛成一个路径段，`fileId` 拿不到标识时不许编。
 */
const ROOT = new URL('../../', import.meta.url)
const { attachmentDiscriminator, attachmentLocalName, hasAttachmentDiscriminator, safeAttachmentFileName } =
  await import(new URL('src/host/h3yun/attachment-name.ts', ROOT).href)

const FIRST = 'c8ef13b8-1111-2222-3333-444455556666'
const SECOND = 'e17ec3db-aaaa-bbbb-cccc-ddddeeeeffff'

test('同名附件按 fileId 分开：两个不同 fileId 得到两个不同的本地名', () => {
  const a = attachmentLocalName('广兴建筑v3.zip', FIRST)
  const b = attachmentLocalName('广兴建筑v3.zip', SECOND)
  assert.equal(a, '广兴建筑v3__c8ef13b8.zip')
  assert.equal(b, '广兴建筑v3__e17ec3db.zip')
  assert.notEqual(a, b, '这就是"不许互相覆盖"的全部依据')
  // 同一个 fileId 永远得到同一个名字：与下载顺序、与重试次数无关。
  assert.equal(attachmentLocalName('广兴建筑v3.zip', FIRST), a)
})

test('没有扩展名 / 多个点 / 隐藏文件都按最后一个点切', () => {
  assert.equal(attachmentLocalName('盘点表', FIRST), '盘点表__c8ef13b8')
  assert.equal(attachmentLocalName('a.b.tar.gz', FIRST), 'a.b.tar__c8ef13b8.gz')
  // 点开头的隐藏文件没有主名可拼：整体当主名。
  assert.equal(attachmentLocalName('.env', FIRST), '.env__c8ef13b8')
})

test('外部文件名先被收敛成一个安全路径段（含中文、空格照常保留）', () => {
  assert.equal(safeAttachmentFileName('广兴建筑 v3.zip'), '广兴建筑 v3.zip')
  // 路径分隔符全被换掉 ⇒ 结果**只能是一段**，`..` 再也拼不出越界路径。
  assert.equal(safeAttachmentFileName('../../etc/passwd'), '.._.._etc_passwd')
  assert.equal(safeAttachmentFileName('../../etc/passwd').includes('/'), false)
  assert.equal(safeAttachmentFileName('C:\\材料\\a.pdf'), 'C__材料_a.pdf')
  assert.equal(safeAttachmentFileName('a\u0000b.txt'), 'a_b.txt')
  // 空 / 纯点 / 纯空白：不许让外部数据决定路径形状。
  for (const junk of ['', '   ', '.', '..', '...']) {
    assert.equal(safeAttachmentFileName(junk), '附件', JSON.stringify(junk))
  }
})

test('fileId 太短（拿不到可靠标识）时不加后缀，也不谎称已区分', () => {
  for (const junk of ['f-1', 'ab', '', undefined, null, 123]) {
    assert.equal(attachmentDiscriminator(junk), '', JSON.stringify(junk))
    assert.equal(attachmentLocalName('a.zip', junk), 'a.zip')
    // 判据在"没有标识"时必须放行（否则会把正常名字全判成违规）。
    assert.equal(hasAttachmentDiscriminator('a.zip', junk), true)
  }
})

test('hasAttachmentDiscriminator 只认真实包含，且大小写不敏感', () => {
  assert.equal(hasAttachmentDiscriminator('广兴建筑v3__c8ef13b8.zip', FIRST), true)
  assert.equal(hasAttachmentDiscriminator('广兴建筑v3__C8EF13B8.zip', FIRST), true, 'fileId 的大小写不该变成误判')
  assert.equal(hasAttachmentDiscriminator('材料-源/广兴建筑v3__c8ef13b8.zip', FIRST), true)
  assert.equal(hasAttachmentDiscriminator('广兴建筑v3.zip', FIRST), false)
  assert.equal(hasAttachmentDiscriminator('广兴建筑v3__e17ec3db.zip', FIRST), false, '别人的标识不算数')
})
