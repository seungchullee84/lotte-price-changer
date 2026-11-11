import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const source = (await readFile(new URL('../portal.mjs', import.meta.url), 'utf8'))
  .replace("'./ledger.mjs'", JSON.stringify(new URL('../ledger.mjs', import.meta.url).href));
const { readGrid } = await import('data:text/javascript;base64,' +
  Buffer.from(source + '\nexport { readGrid };').toString('base64'));

test('horizontal virtual cells and negative header indexes are read and scrollbar restored', async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 800, height: 400 } });
    await page.setContent('<div id="fixture"></div>');
    await page.evaluate(() => {
      const id = 'mainframe_WorkFrame_OCPIPMOnlnRgstPrdcInqM_2_88_form_div_Work_div_Data_grd_Master';
      const grid = document.createElement('div');
      grid.id = id;
      grid.style.cssText = 'position:relative;width:600px;height:220px';
      document.querySelector('#fixture').append(grid);
      const body = document.createElement('div');
      body.id = id + '_body';
      grid.append(body);
      for (const [column, label] of [[19, '스타일'], [20, '상품코드'], [22, '판매가']]) {
        const header = document.createElement('span');
        header.id = id + '_head_gridrow_-1_cell_-1_' + column;
        header.textContent = label;
        grid.append(header);
      }
      const values = { 5: '동탄점', 8: '롯데ON', 18: '23', 19: '상품', 20: '026990',
        21: 'product-1', 23: '49,800', 24: '44,200', 34: '진행중', 35: '44,200', 37: '34',
        38: '20991111', 53: 'N', 54: '이미 등록한 판매가변경이 승인완료후 적용전 상태입니다.' };
      function render(fraction) {
        const columns = fraction > 0.8 ? [44, 54] : fraction > 0.2 ? [24, 43] : [0, 33];
        body.replaceChildren();
        for (let column = columns[0]; column <= columns[1]; column++) {
          const cell = document.createElement('span');
          cell.id = id + '_body_gridrow_0_cell_0_' + column;
          cell.textContent = values[column] ?? '';
          body.append(cell);
        }
      }
      const bar = document.createElement('div');
      bar.id = id + '_hscrollbar';
      bar.style.cssText = 'position:absolute;top:160px;left:0;width:600px;height:20px;background:#ddd';
      for (const [name, css] of [['decbutton', 'left:0;width:20px'], ['incbutton', 'right:0;width:20px'],
        ['trackbar', 'left:20px;width:80px;background:#333']]) {
        const control = document.createElement('div');
        control.id = bar.id + '_' + name;
        control.style.cssText = 'position:absolute;height:20px;' + css;
        bar.append(control);
      }
      grid.append(bar);
      const thumb = document.getElementById(bar.id + '_trackbar');
      let dragging = false;
      thumb.addEventListener('mousedown', () => { dragging = true; });
      document.addEventListener('mouseup', () => { dragging = false; });
      document.addEventListener('mousemove', event => {
        if (!dragging) return;
        const fraction = Math.max(0, Math.min(1, (event.clientX - bar.getBoundingClientRect().left - 60) / 480));
        thumb.style.left = (20 + 480 * fraction) + 'px';
        render(fraction);
      });
      render(0);
    });
    const [row] = await readGrid(page);
    assert.equal(row.code, '026990');
    assert.equal(row.scheduledStatus, '진행중');
    assert.equal(row.scheduledPrice, '44,200');
    assert.equal(row.portalSuccess, 'N');
    assert.match(row.portalResult, /승인완료후 적용전/);
    assert.equal(await page.locator('[id$="_hscrollbar_trackbar"]').evaluate(element => element.style.left), '20px');
  } finally {
    await browser.close();
  }
});
