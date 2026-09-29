import { expect, test } from '@playwright/test';

test('new user can create a book and keep a dog ear', async ({ page }) => {
  const email = `acceptance-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill('acceptance-password');
  await page.getByLabel('确认密码').fill('acceptance-password');
  await page.getByRole('button', { name: '创建账号' }).click();

  await expect(page.getByRole('heading', { name: '我的书' })).toBeVisible();
  await page.getByRole('link', { name: '添加第一本书' }).click();
  await page.getByLabel('书名').fill('验收测试书');
  await page.getByLabel('总页数').fill('300');
  await page.getByRole('button', { name: '保存书目' }).click();

  await expect(page.getByRole('heading', { name: '验收测试书' })).toBeVisible();
  await page.getByRole('button', { name: '记一次折角' }).click();
  await page.getByLabel('页码').fill('42');
  await page.getByLabel('折角原因（可选）').fill('这一页与当下有关。');
  await page.getByRole('button', { name: '保存痕迹' }).click();

  await expect(page.getByText('第 42 页').first()).toBeVisible();
  await expect(page.getByText('这一页与当下有关。')).toBeVisible();
});

test('same page rereads aggregate into ordered rounds and can be filtered by reason', async ({ page }) => {
  const email = `reread-${Date.now()}@example.com`;
  await page.goto('/register');
  await page.getByLabel('邮箱').fill(email);
  await page.getByLabel('密码', { exact: true }).fill('acceptance-password');
  await page.getByLabel('确认密码').fill('acceptance-password');
  await page.getByRole('button', { name: '创建账号' }).click();

  await expect(page.getByRole('heading', { name: '我的书' })).toBeVisible();
  await page.getByRole('link', { name: '添加第一本书' }).click();
  await page.getByLabel('书名').fill('重读测试书');
  await page.getByLabel('总页数').fill('300');
  await page.getByRole('button', { name: '保存书目' }).click();
  await expect(page.getByRole('heading', { name: '重读测试书' })).toBeVisible();

  async function markReread(pageNumber: string, reason: string | null): Promise<void> {
    await page.getByRole('button', { name: '标记重读页' }).click();
    await page.getByLabel('页码').fill(pageNumber);
    if (reason) await page.getByLabel('为什么重读这一页（可选）').fill(reason);
    await page.getByRole('button', { name: '保存痕迹' }).click();
    await expect(page.getByText('阅读痕迹已保存')).toBeVisible();
  }

  await markReread('42', '第一次被开头击中。');
  await markReread('42', '第二次才读懂结尾。');
  await markReread('50', null);

  await page.getByRole('tab', { name: /重读/ }).click();

  await expect(page.getByText('第 42 页').first()).toBeVisible();
  await expect(page.getByText('共重读 2 次')).toBeVisible();
  await expect(page.getByText('共重读 1 次')).toBeVisible();
  // 同页多次重读按先后编号，较早的一条排在前面。
  await expect(page.getByText('第 1 次重读')).toBeVisible();
  await expect(page.getByText('第 2 次重读')).toBeVisible();
  const firstRound = page.locator('.trace-card', { hasText: '第 1 次重读' });
  await expect(firstRound).toContainText('第一次被开头击中。');
  const secondRound = page.locator('.trace-card', { hasText: '第 2 次重读' });
  await expect(secondRound).toContainText('第二次才读懂结尾。');

  // 按原因筛选：只保留对应记录，轮次编号仍是全量口径。
  await page.getByLabel('重读原因').selectOption('第一次被开头击中。');
  await expect(page.getByText('共 1 条重读 · 1 个页面')).toBeVisible();
  await expect(page.getByText('第一次被开头击中。')).toBeVisible();
  await expect(page.getByText('第二次才读懂结尾。')).toHaveCount(0);

  // 只看未填写原因：第 50 页那一条出现，有原因的页不出现。
  await page.getByLabel('重读原因').selectOption('未填写原因');
  await expect(page.getByText('共 1 条重读 · 1 个页面')).toBeVisible();
  await expect(page.getByText('第 50 页').first()).toBeVisible();
  await expect(page.getByText('第 42 页')).toHaveCount(0);

  // 删除未填写原因的一条后切回全部：计数与顺序仍一致。
  const emptyRound = page.locator('.trace-card', { hasText: '未填写原因' });
  page.once('dialog', (dialog) => void dialog.accept());
  await emptyRound.getByRole('button', { name: '删除' }).click();
  await expect(page.getByText('没有符合该原因的重读记录。')).toBeVisible();

  await page.getByLabel('重读原因').selectOption('全部原因');
  await expect(page.getByText('共 2 条重读 · 1 个页面')).toBeVisible();
  await expect(page.getByText('第 42 页').first()).toBeVisible();
  await expect(page.getByText('第 50 页')).toHaveCount(0);
  await expect(page.getByText('共重读 2 次')).toBeVisible();
});
