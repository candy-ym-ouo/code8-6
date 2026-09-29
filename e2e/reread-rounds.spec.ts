import { expect, test } from '@playwright/test';

test('same-page rereads are grouped into ordered rounds, survive filtering and deletion', async ({ page }) => {
  const email = `reread-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill('acceptance-password');
  await page.getByLabel('确认密码').fill('acceptance-password');
  await page.getByRole('button', { name: '创建账号' }).click();

  await expect(page.getByRole('heading', { name: '我的书' })).toBeVisible();
  await page.getByRole('link', { name: '添加第一本书' }).click();
  await page.getByLabel('书名').fill('重读验收书');
  await page.getByLabel('总页数').fill('300');
  await page.getByRole('button', { name: '保存书目' }).click();

  await expect(page.getByRole('heading', { name: '重读验收书' })).toBeVisible();

  async function addReread(pageNumber: string, reason: string): Promise<void> {
    await page.getByRole('button', { name: '标记重读页' }).click();
    await page.getByLabel('页码').fill(pageNumber);
    await page.getByLabel('为什么重读这一页（可选）').fill(reason);
    await page.getByRole('button', { name: '保存痕迹' }).click();
    await expect(page.getByText('阅读痕迹已保存')).toBeVisible();
  }

  await addReread('42', '第一次回到这里');
  await addReread('42', '第二次，想确认细节');
  await addReread('42', '');

  await page.getByRole('tab', { name: /^重读 3/ }).click();

  // 同页三次重读聚合成一组，轮次按先后展示。
  const group = page.locator('.reread-group', { hasText: '第 42 页' });
  await expect(group).toBeVisible();
  await expect(group.getByText('重读 3 次')).toBeVisible();
  await expect(group.getByText('第 1 次重读')).toBeVisible();
  await expect(group.getByText('第 2 次重读')).toBeVisible();
  await expect(group.getByText('第 3 次重读')).toBeVisible();
  await expect(group.getByText('第一次回到这里')).toBeVisible();

  // 原因筛选：只看写了原因的两次。
  await page.getByRole('radio', { name: '写了原因' }).check();
  await expect(group.getByText('第 1 次重读')).toBeVisible();
  await expect(group.getByText('第 2 次重读')).toBeVisible();
  await expect(group.getByText('第 3 次重读')).toHaveCount(0);
  await page.getByRole('radio', { name: '没写原因' }).check();
  await expect(group.getByText('第 3 次重读')).toBeVisible();
  await expect(group.getByText('第一次回到这里')).toHaveCount(0);
  await page.getByRole('radio', { name: '全部' }).check();
  await expect(group.getByText('重读 3 次')).toBeVisible();

  // 删除中间一轮：计数与剩余顺序保持一致，轮次号不复用。
  page.on('dialog', (dialog) => dialog.accept());
  await group
    .locator('.reread-round', { hasText: '第 2 次重读' })
    .getByRole('button', { name: '删除' })
    .click();
  await expect(page.getByText('已删除，可在 24 小时内撤销')).toBeVisible();
  await expect(page.getByRole('tab', { name: /^重读 2/ })).toBeVisible();
  await expect(group.getByText('第 1 次重读')).toBeVisible();
  await expect(group.getByText('第 2 次重读')).toHaveCount(0);
  await expect(group.getByText('第 3 次重读')).toBeVisible();
  await expect(group.getByText('重读 2 次')).toBeVisible();
});
