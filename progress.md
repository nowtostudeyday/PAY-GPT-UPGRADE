

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
