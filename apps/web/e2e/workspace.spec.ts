import { test, expect } from '@playwright/test';
test.beforeEach(async({page})=>{await page.goto('/');await page.evaluate(()=>localStorage.clear());await page.reload();});
test('creates a server, sends a message, edits, pins, and retains it on reload',async({page})=>{
 await page.getByRole('button',{name:'Create a server',exact:true}).click();await page.getByLabel('SERVER NAME').fill('Midnight Squad');await page.getByRole('button',{name:'Create server',exact:true}).click();
 await expect(page.getByRole('button',{name:'Midnight Squad',exact:true}).first()).toBeVisible();
 await page.getByRole('textbox',{name:'Message',exact:true}).fill('First message from the squad');await page.getByRole('button',{name:'Send message',exact:true}).click();
 const row=page.locator('article').filter({hasText:'First message from the squad'});await expect(row).toBeVisible();await row.hover();await row.getByRole('button',{name:'Edit message',exact:true}).click();
 await page.getByRole('textbox',{name:'Message',exact:true}).fill('Edited squad message');await page.getByRole('button',{name:'Save edit',exact:true}).click();
 await expect(page.getByText('Edited squad message',{exact:true})).toBeVisible();await page.reload();await expect(page.getByText('Edited squad message',{exact:true})).toBeVisible();
 const edited=page.locator('article').filter({hasText:'Edited squad message'});await edited.hover();await edited.getByRole('button',{name:'Pin message',exact:true}).click();await page.getByRole('button',{name:'Pinned messages',exact:true}).click();await expect(page.getByText('Edited squad message',{exact:true})).toBeVisible();
});
test('searches messages, opens voice history, and filters the sample transcript',async({page})=>{
 await page.getByRole('textbox',{name:'Search Vexa'}).fill('dialing');await expect(page.locator('.search-results')).toContainText('Anyone down');await page.getByRole('button',{name:'Close search',exact:true}).last().click();
 await page.getByRole('button',{name:/Voice history/}).click();await expect(page.getByText('Sample transcript · Preview')).toBeVisible();await page.getByPlaceholder('Search this conversation').fill('rotate');await expect(page.locator('.transcript-line')).toHaveCount(1);
});
test('escapes HTML in messages and confirms deletion',async({page})=>{
 await page.getByRole('textbox',{name:'Message',exact:true}).fill('<img src=x onerror="window.pwned=1">');await page.getByRole('button',{name:'Send message',exact:true}).click();
 await expect(page.locator('article').last()).toContainText('<img');expect(await page.evaluate(()=>('pwned' in window))).toBe(false);
 const last=page.locator('article').last();await last.hover();await last.getByRole('button',{name:'Delete message',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Delete message',exact:true}).click();await expect(page.locator('article').filter({hasText:'<img src=x'})).toHaveCount(0);
});
test('mobile navigation and composer remain usable without horizontal overflow',async({page})=>{
 await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Toggle channels'}).click();await page.getByRole('button',{name:'clips-and-highlights',exact:true}).click();await expect(page.getByRole('heading',{name:'clips-and-highlights',exact:true})).toBeVisible();
 await page.getByRole('textbox',{name:'Message',exact:true}).fill('Mobile squad check');await page.getByRole('button',{name:'Send message',exact:true}).click();await expect(page.getByText('Mobile squad check',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
});
