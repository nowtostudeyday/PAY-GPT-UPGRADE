

## 2026-08-25 - Task: 支持 Docker 有头浏览器调试
### What was done
- Compose 的 `HEADFUL` 改为读取 `.env`，不再固定为 `0`。
- `HEADFUL=1` 时，容器启动 Xvfb、x11vnc 和 noVNC；通过本机 noVNC 查看容器内 Chromium。
- Docker 浏览器启动统一添加 sandbox 兼容参数，支持 root 容器中的有头 Chromium。
### Testing
- 待 Docker daemon 启动后执行 `docker compose up -d --build app` 验证。
### Notes
- 有头调试必须设置 `VNC_PASSWORD`，noVNC 只绑定本机 `127.0.0.1`。
- 远程服务器请使用 SSH 隧道访问 noVNC，禁止直接暴露端口。


## 2026-08-25 - Task: 支付链接调试支持 API 回退 UI
### What was done
- 支付链接调试 worker 使用与正式充值相同的 `CHECKOUT_MODE=api`：优先尝试内部 Checkout API，失败后回退定价页套餐选择流程。
- API 成功时，调试任务同样打开 Checkout 页面，确认最终付款按钮出现后才停止。
- 调试流程确认最终订阅/支付按钮已可见后输出链接并返回，不会调用填卡、订阅或扣款逻辑。
- API 模式即使处于调试状态，创建失败时也允许回退 UI，避免调试路径被提前中断。
### Testing
- `node --check index.js`、`node --check server.js` 通过。
### Notes
- 调试页提示已同步为 API 优先、失败回退 UI 的流程。
- 正式充值流程保持既有行为；`CHECKOUT_DEBUG_ONLY=1` 仅在最终付款前停止。


## 2026-08-25 - Task: 收紧 UI 定价页套餐按钮定位
### What was done
- 在菲律宾定价页核验 Plus 和 Pro 按钮的稳定 `data-testid`：`select-plan-button-plus-upgrade`、`select-plan-button-pro-upgrade`。
- UI 升级流程改为仅按套餐 `data-testid` 精确定位；移除按钮文案、class、XPath 和全页 `Upgrade` 兜底。
- 按钮缺失、不可见或匹配数量不为 1 时直接失败，避免误点其他套餐。
- Pro 先在定价页选择 5x/20x 并校验，再在 Checkout 使用 `#chatgptprolite` / `#chatgptpro` 精确选择并确认最终档位。
### Testing
- 浏览器只读核验：菲律宾定价页的 Plus、Pro `data-testid` 均唯一且可见。

## 2026-08-25 - Task: 等待定价页套餐卡片后再切换地区

- 定价页导航完成后固定等待 5 秒，再处理人机验证与登录态。
- 仅在 Plus 或 Pro 的稳定 `data-testid` 唯一且可见时，才视为已进入定价页；并在地区切换前再次确认本次请求套餐的按钮已就绪；否则最多额外等待 10 秒后明确失败。
- 新增 `test/pricing-checkout.test.js` 覆盖套餐 test id 映射与未知套餐失败。
### Notes
- `pro_5x` 与 `pro_20x` 共用外层 ChatGPT Pro 按钮，再通过两阶段档位选择完成 UI 区分；Checkout 未出现唯一对应选项时会失败，不会继续支付。


## 2026-08-25 - Task: 修復 UI 定價頁 Plus 誤選套餐
### What was done
- 移除 Plus 流程的全頁通用 `Upgrade` 按鈕匹配，避免在定價頁新增 Go 等套餐後誤點第一個升級按鈕。
- 新增「重新加入 Plus」按鈕文案匹配，適配目前中文定價頁的 Plus 卡片。
### Testing
- `node --check pricing-checkout.js` 通過。
- `git diff --check` 通過。
### Notes
- 變更檔案：`pricing-checkout.js`、`progress.md`。
- 回滾方式：還原上述兩個檔案；回滾後 Plus UI 流程會重新允許匹配全頁通用 `Upgrade` 按鈕。


## 2026-08-14 - Task: 修復 GPT 代充 API 協議代理傳參
### What was done
- Session inspect 保留為不使用代理的本機格式／到期檢查。
- 執行代充時從本地代理池取得啟用代理並傳入 `/pay.proxy`；本地池為空時省略欄位，由平台啟用代理池兜底。
- 完整 Session payload 繼續傳入，固定 CDK 冪等鍵不變。
- 重寫 `協議api.md`，對齊 inspect 無代理、Worker 協議有代理的新規格。
- 修正 Vitest CommonJS 測試載入方式。
### Testing
- `node --check gpt-api-client.js`、`node --check server.js` 通過。
- `npm test -- test/gpt-api-client.test.js`：3 passed。
- 線上使用正式 API 設定呼叫 inspect 成功，回 `reason=local_check`。
- 契約驗證確認 `/pay` payload 同時包含完整 Session 與 proxy。
- `docker compose up -d --build app` 成功，app 容器 healthy。
### Notes
- `gpt-api-client.js`：`submitPay` 支援並傳送 proxy。
- `server.js`：取得協議代理並傳入平台，保留平台代理回退。
- `test/gpt-api-client.test.js`：改驗證 proxy 會傳送並修復 Vitest 載入。
- `協議api.md`：更新完整協議與 403 風險說明。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並執行 `docker compose up -d --build app`；回滾會恢復不傳代理的舊行為。


## 2026-08-14 - Task: 補齊 GPT API 套餐與卡片相容性
### What was done
- 新增 `pro_5x → pro5x`、`pro_20x → pro20x` 映射，inspect 與 pay 共用同一平台套餐鍵。
- `GET /plans` 客戶端支援平台 `{gpt, credit}` 回應。
- 卡片有效期嚴格支援 `MMYY`、`MM/YY`、`MM/YYYY`；無效格式明確失敗，不再回退 2030。
### Testing
- Node 語法檢查通過。
- `npm test -- test/gpt-api-client.test.js`：4 passed。
### Notes
- `server.js`：新增套餐鍵映射與有效期解析。
- `gpt-api-client.js`：支援 `raw.gpt` 套餐陣列。
- `test/gpt-api-client.test.js`：增加 plans 回應契約測試。
- `協議api.md`：補充套餐映射及有效期格式。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並重建 app；回滾會使 Pro 套餐重新可能回 `plan_disabled`。


## 2026-08-14 - Task: 修復平台任務 done 誤判激活成功
### What was done
- 查詢 task 時優先讀取 `result.status`，不再把 queue 外層 `done` 當業務成功。
- 移除 `done` 成功終態；`result.ok=false` 強制按失敗處理並顯示內層錯誤。
### Testing
- `npm test -- test/gpt-api-client.test.js`：5 passed。
- 線上容器契約驗證：`done + result.failed → failed`，`done + result.success → success`。
- app 重建部署成功，容器 healthy。
### Notes
- `gpt-api-client.js`：優先解析內層業務狀態。
- `server.js`：移除 done 成功映射並使用 result.ok／error。
- `test/gpt-api-client.test.js`：新增 queue done 與業務終態回歸測試。
- `progress.md`：追加本輪記錄。
- 回滾方式：還原上述檔案並重建 app；回滾會再次把失敗任務誤報成功。
