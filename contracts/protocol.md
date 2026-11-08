# Claw-Next 协议 1.0

此文件是前后台共同基线。时间为 UTC Unix 秒，ID 为匹配 `[A-Za-z0-9_.:-]{1,128}` 的字符串；HTTP JSON UTF-8。后台启动时配置店铺和客户端身份；**请求内的店铺名不授予权限**。前台 token 固定绑定一个 `client_id` 和一个 `shop_id`。所有受保护 API 使用 `Authorization: Bearer <token>`，禁止放 URL。管理员使用账号密码换取短期会话，管理员会话和客户端 token 不能互相替代。示例全部是虚构数据。

开发地址默认 `http://127.0.0.1:18880`；云端使用 HTTPS 反向代理。v1 不依赖其他系统的任何端口/配置。客户端从后台响应确认 `protocol_version=1.0`，不支持的主版本停用发送。JSON 错误统一 `{"error":{"code":"...","message":"..."}}`；400=格式错误，401=未认证，403=角色错误，404=不存在，409=状态冲突，413=过大。未知接口不执行任何业务。请求体按完整 JSON 编码后的 UTF-8 字节数计量，默认上限 256 KiB（262144 字节）。POST 特例：`/api/v1/events` 为 8 MiB（8388608 字节），`/api/v1/admin/chat-import` 及 `/api/v1/admin/chat-import/jobs` 为 40 MiB（41943040 字节），`/api/v1/admin/rule-draft` 及 `/api/v1/admin/rule-draft/jobs` 为 4 MiB（4194304 字节）；其他接口不放宽。超过对应请求体上限返回 413 `body_too_large`，字段自身的限制另行校验。

## 健康与身份

`GET /health` 无认证，返回 `{"service":"claw-next","protocol_version":"1.0","status":"ok"}`。这仅说明 HTTP 服务可达。

`GET /api/v1/me` 返回当前身份。客户端返回 `{"role":"client","client_id":"demo-client","shop_id":"demo-shop","protocol_version":"1.0"}`，管理员返回 `{"role":"admin","username":"admin","must_change_password":false,"protocol_version":"1.0"}`；仍使用初始密码时 `must_change_password` 为 `true`。客户端身份响应不增加此字段。

## 管理员登录与密码迁移

此更新只替换管理员认证；每店客户端 Bearer token、身份、消息、租约、claim 和回执字段及语义保持 1.0。前台收发客户端不得调用管理员登录来取得店铺权限。

- `POST /api/v1/admin/login`：无认证，JSON `{"username":"admin","password":"admin"}`。成功 200：`{"role":"admin","username":"admin","session_token":"<不透明会话值>","expires_at":1790028800.0,"must_change_password":true,"protocol_version":"1.0"}`。后续管理 API 用此会话值作 Bearer；禁止 URL、日志或持久化浏览器存储。账号密码错误统一 401 `invalid_credentials`，格式错误 400。首次初始化默认 admin/admin；已有管理员密码不会被启动配置覆盖。`must_change_password` 表示当前持久化密码仍为初始密码；已改密账号登录时为 `false`。
- `POST /api/v1/admin/password`：管理员 Bearer，JSON `{"current_password":"admin","new_password":"<新密码>","confirm_password":"<相同新密码>"}`。新密码 8–128 字符，不能等于当前密码。成功 200 `{"ok":true,"reauthenticate":true}`，立即撤销全部管理员会话（包括当前会话）；旧密码失效，必须重新登录。错误当前密码 403 `current_password_incorrect`；确认不一致 400 `password_mismatch`；新密码太短 400 `invalid_new_password`；与当前相同 400 `password_unchanged`；缺失、类型/编码错误或超过长度上限 400 `invalid_password_request`。这些失败不改变密码、首次改密状态或现有会话；新密码成功提交后才清除首次改密状态并撤销会话。
- `POST /api/v1/admin/logout`：管理员 Bearer，JSON `{}`。200 `{"ok":true}` 仅撤销当前会话。响应丢失时客户端不能声称服务端已确认退出；可以丢弃本地会话并提示。

当 `must_change_password=true` 时，该管理员会话只允许 `GET /api/v1/me`、`POST /api/v1/admin/password` 和 `POST /api/v1/admin/logout`；其余管理接口（含模型连接测试）在读取业务数据、修改配置或调用模型前返回 403 `admin_password_change_required`。管理界面必须先完成改密，不能仅隐藏提示后继续读取业务数据。原有客户端 token 与客户端接口不受此管理员门槛影响。协议版本仍为 1.0；旧管理调用方收到该错误时应引导改密，不能自动重试原操作。

测试初始化应使用隔离的虚构数据目录：默认登录后通过正常改密接口设置本次测试专用密码，再重新登录取得新会话。不得添加绕过首次改密的测试开关。

会话为服务端内存保存的随机值（只保存摘要），最长 8 小时绝对有效期；到期、退出、改密或后台重启后返回 401 `unauthorized`。管理页只在内存保存会话，刷新后重新登录。最多保留 64 个有效管理员会话，超出时撤销最早到期的会话。未登录不能访问管理接口；客户端 token 访问管理接口为 403，管理员访问客户端业务接口也为 403。

登录及改密的错误密码按连接来源地址共用限制：60 秒内 10 次失败后返回 429 `login_rate_limited`，到期后可再次尝试；不信任客户端提供的代理地址头。远程部署仍需 HTTPS 代理及入口限流，代理下多个用户可能共用同一来源地址。

管理员使用独立盐及 PBKDF2-HMAC-SHA256（600,000 次）持久化到数据目录 `admin.sqlite3`，不保存明文密码。旧配置可保留 `admin_token` 字段，但该值永远不参与管理员认证，也不能与客户端 token 相同。新版初始化配置不再生成管理员静态 token。升级时保留整个数据目录；不要删除管理员数据库来重置密码。默认 admin/admin 只用于首次登录，必须先在回环地址完成改密，再考虑受控远程访问。已使用自定义密码的旧安装不重复强制；仍使用默认密码的旧安装升级后同样受此限制。本密码迁移不改变既有管理员表结构；下述本机授权另用独立表保存摘要。

### 本机客户端打开管理页（1.0 增量，独立授权）

首次由用户在现有管理页输入管理员账号密码，完成首次改密并重新登录，再手动生成本机授权码、填入客户端一次。该码授予**打开完整管理后台及在本机登记店铺**的权限，独立于每店 client token；店铺口令、管理员会话、本机授权码三类凭据不能互换。客户端按后台的完整 HTTP(S) origin 将授权码保存到系统钥匙串，不写普通配置、日志或浏览器存储，不把管理员密码交给客户端。不得因连接某个店铺自动生成或取得本机授权。

下列所有接口仅允许实际连接来源为 `127.0.0.1` 或 `::1`，否则 403 `local_only`；不以代理头判断来源。此限制不证明调用者是某个本机程序，也不替代授权码。客户端先规范化后台 URL，仅允许 HTTP(S)、无用户信息/查询串/fragment、路径为空或 `/`，且 hostname 恰为 `127.0.0.1`、`[::1]` 或 `localhost`；`localhost` 包含在本机地址范围内，后台仍按实际连接来源核对。授权按规范化后的完整 origin（协议、主机、端口）分别保存，这三种主机写法不互通授权，不向远程来源发送授权、不跟随重定向。

| 接口 | 认证、请求与成功响应 |
|---|---|
| `POST /api/v1/admin/handoff/grants` | 已完成首次改密的管理员会话，JSON `{}`；200 `{grant_id, grant_token, created_at, protocol_version}`。授权码仅此时返回一次 |
| `GET /api/v1/admin/handoff/grants` | 同一管理员门槛；200 `{grants:[{grant_id,created_at}], protocol_version}`，不返回授权码或摘要 |
| `DELETE /api/v1/admin/handoff/grants/{grant_id}` | 同一管理员门槛，无请求体；200 `{ok:true, protocol_version}`。合法 ID 不存在时仍成功，以便在响应丢失后核对/撤销 |
| `POST /api/v1/admin/handoff` | **本机授权码**作 Bearer，JSON `{}`；200 `{ticket, expires_at, protocol_version}`。店铺口令、管理员会话、未知/已撤销/格式错误授权均 401 `invalid_handoff_grant` |
| `POST /api/v1/admin/handoff/redeem` | 无 Bearer，JSON `{ticket:"<票据>"}`；200 返回与管理员密码登录相同的会话结构。未知、过期、已用、格式错误或所属授权已撤销统一 401 `invalid_handoff` |
| `POST /api/v1/admin/handoff/shops` | 已保存的本机授权码作 Bearer，JSON 恰为 `{shop_id,name,client_id,client_token}`；200 `{shop_id,name,client_id,created,protocol_version:"1.0"}`，不返回口令或管理员会话 |

- `grant_id` 是 32 位小写十六进制随机 ID；`grant_token` 和 `ticket` 都是由 32 随机字节产生的 43 位 URL-safe 字符串（`[A-Za-z0-9_-]{43}`）。授权码只存摘要、ID 和创建时间到现有受保护的管理员数据库；后台重启后授权仍有效。最多 8 个授权，达到上限时 409 `handoff_grant_limit`，用户先撤销旧授权。签发和创建请求必须为空对象，其他字段 400 `invalid_handoff_request`；兑换必须恰好一个 `ticket` 字段，额外或缺失字段也按无效票据处理。
- 票据只在服务端内存保存摘要，绝对有效期 60 秒；最多 8 个未过期票据，上限时 409 `handoff_ticket_limit`，不自动作废另一打开请求。并发兑换在同一锁内校验、消耗并创建会话，最多一次成功；票据所属授权在兑换时重核。无效授权及无效兑换与密码登录/改密共用实际连接来源的 10 次/60 秒失败限制（429 `login_rate_limited`）。请求/响应丢失或结果不明不自动重试，用户可重新点击打开。
- 撤销授权使其全部待兑换票据同时失效，已兑换的普通管理员会话按原规则继续。普通退出只撤销当前页面会话，不撤销本机授权；管理页对此明确说明。管理员改密成功在同一数据库事务撤销全部授权，并清除全部会话及待兑换票据；改密失败不改变它们。后台重启清空会话与票据，保留授权。
- 客户端用票据打开同一配置 origin 的 `/#handoff=<ticket>`；票据不得进查询串。管理页在任何请求前立即清除 fragment，将票据保留在局部内存并仅兑换一次，失败回普通密码登录。兑换成功的会话仍仅在页面内存中，最长 8 小时、总数 64 的限制不变，刷新后需从客户端重新打开或密码登录。
- 客户端成功打开链接只说明浏览器打开请求已完成，提示“已打开登录链接，结果在浏览器查看”；没有浏览器兑换回执不能声称“已登录”。旧后台 404 表示不支持，回普通密码登录，不尝试店铺口令或静态管理员口令。错误仅映射封闭分类，不显示或记录后台任意错误原文、票据、授权码。

本增量只增加管理页进入方式，不改变任何店铺、自动回复、模型、客户端启动模式或平台动作能力。共同审查通过和代码合入不等于实际部署、客户端更新或授权启用。

### 本机店铺自动登记（1.0 增量）

个人本机使用时，新增店铺由客户端自动登记到后台，不再逐店手工复制口令。已有的本机授权码复用，不新增管理员密码输入，也不以其他店铺口令取得登记权限。上述本机来源、精确 origin、禁止重定向和授权撤销/首次改密门槛同样适用于 `/handoff/shops`；无效授权与现有登录限制共用 10 次/60 秒失败限制。

- `shop_id`、`client_id` 均为 1–128 位 `[A-Za-z0-9_.:-]`；`name` 为去掉首尾空白后非空、最多 128 字符的名称；`client_token` 必须为客户端用 32 随机字节生成的 43 位 `[A-Za-z0-9_-]`。字段缺失、额外字段或类型/格式不符返回 400 `invalid_shop_registration`。客户端在发送登记请求前，先将本次稳定的 `client_id` 及口令按店铺和后台 origin 保存（口令仅在系统安全存储中）；请求/响应及日志不得公开口令。
- 后台在一次事务中保存店铺和客户端口令摘要，重启后仍能列出该店并认证同一客户端。新店使用默认设置，`enabled=false`；既有活动店铺的名称、规则、开关、模型、连接凭据和租约不被此接口覆盖。只曾留在数据库但已不在活动配置中的历史店铺编号返回 409 `shop_id_reserved`，不借登记恢复其历史自动回复设置。
- 相同 `shop_id/client_id/client_token` 重复提交返回既有店铺，`created=false`；首次新建店铺时 `created=true`。已有活动店铺收到全新的 `client_id` 和全新口令时，为该店新增客户端绑定，返回 `created=false`，旧绑定和店铺设置保持不变，同店发送者仍由既有租约约束。同一客户端编号绑定不同店铺/口令、口令已用于其他客户端、与配置中的客户端编号/口令冲突，或以本机授权码、管理员会话/旧静态口令充当店铺口令，均 409 `client_registration_conflict`，不轮换或覆盖旧口令。响应 `name` 是后台实际保存的名称。
- 响应丢失或超时不自动重试、不重新生成凭据；用户重新连接时可用原先安全保存的同一组值核对幂等结果。旧后台 404 时明确提示后台版本不支持，不降级为无认证登记。授权缺失或已撤销则提示完成一次本机授权，不能静默创建授权或索取管理员密码。
- 登记出的店铺口令仍只具有本店客户端权限，不能调用管理接口或登记其他店铺。本机授权码撤销/改密阻止后续登记；已登记的店铺凭据独立保留。登记与连接不启用自动回复、标星或转人工，也不代表平台已登录或真实业务验收通过。
- 客户端删除本地店铺配置不注销后台绑定；本增量没有新增后台解绑界面，不把旧绑定自动删除或轮换。个人本机主流程隐藏手填店铺口令，缺少本机授权时提示先授权；远程或旧版本的兼容口令入口仅放在折叠的高级设置内，既有已配对店铺不自动迁移。

## 1. 取得并续租发送归属

`POST /api/v1/heartbeat`，客户端请求：

```json
{"instance_id":"instance-001","session_id":"session-001"}
```

响应 `{"shop_id":"demo-shop","client_id":"demo-client","instance_id":"instance-001","session_id":"session-001","generation":1,"expires_at":1790000060.0}`。

租约 60 秒，每 15 秒续租。相同客户端同一实例/会话续租保持 generation；其他实例或客户端在有效租约期内返回 409 `lease_busy`。会话更换只允许当前实例（旧会话任务随即失效）或原租约过期后新实例取得；generation 增加。失联、过期、实例或代数不匹配时禁止新任务和发送。客户端每次启动生成新 instance_id，平台重新登录/切店时生成新 session_id。后台租约只能协调 Claw-Next 客户端，**不能自动阻止其他自动回复工具发送**。

以下需要身份归属的请求携带同一组字段 `instance_id, session_id, generation`。

## 2. 提交新消息及完整上下文

`POST /api/v1/events`：

```json
{
  "event_id":"event-001",
  "instance_id":"instance-001","session_id":"session-001","generation":1,
  "conversation_id":"buyer-demo-001","message_id":"message-001","context_revision":1,
  "received_at":1790000000.0,
  "context":{"history_complete":true,"messages":[
    {"id":"message-001","role":"buyer","kind":"text","content":"营业时间是什么时候？","created_at":1790000000.0}
  ]}
}
```

`message_id` 必须是上下文最后一条消息，角色 buyer。每个消息必须有 id/role/kind/content/created_at；role 为 buyer/agent/system，kind 为 text/image/card/unsupported；消息按时间非递减排序，id 不重复。上下文 1–200 条，每条 content 最多 8000 字符；超限拒绝，前台不得截断后伪称完整。图片/卡片保存可读文字或安全的占位描述。图片与卡片按下文“图片与卡片（1.0 补充）”处理，不再一律转人工。

`history_complete=false` 如实表示早期历史缺失，**不再单独阻止判断、claim 或发送**。后台仍根据本次提供的可见消息、已保存规则与已核实规格回答最新买家问题；模型须明确知晓历史不完整，不得补造遗漏对话或先前承诺，缺少必要信息时以简短回复追问，不能只因缺历史而转人工。rules 模式仍只匹配最新买家消息；hybrid 模式按下述语义流程结合可见上下文，不将缺历史伪装为完整。业务确实需要人工权限时仍可 handoff。前台保留原标记；店铺身份、实时新消息/最新版本、租约、预算、发送候选与单次尝试等其余校验继续生效。此修改不触发历史回补消息的自动回复，也不重放终态或 unknown 事件。

### 图片与卡片（1.0 补充）

消息可带两个可选字段。旧字段保持兼容；最新买家图片缺图时后台会请买家补发，历史中的非文字消息不再单独导致转人工：

```json
{"id":"message-009","role":"buyer","kind":"image","content":"[图片]","created_at":1790000300.0,
 "attachments":[{"type":"image","mime":"image/jpeg","data_url":"data:image/jpeg;base64,..."}]}
{"id":"message-010","role":"buyer","kind":"card","content":"商品卡片：示例商品","created_at":1790000310.0,
 "card":{"type":"goods","title":"示例商品","description":"规格：示例","fields":[{"label":"价格","value":"示例"}]}}
```

- `attachments` 只允许出现在上下文**最后一条 buyer 消息**上，其他位置 400。每项 `type=image`，`mime` 只能是 `image/png` / `image/jpeg` / `image/webp`，且必须与 `data_url` 头部一致；最多 3 张，每张解码后不超过 2 MiB；超过 3 张或超过大小返回 413，其他格式不符返回 400。前台不压缩、不截断冒充原图。
- 前台只在本店已登录的平台页面中读取该消息的图片，只取平台自身图片域名；后台不持有平台 Cookie，不抓取任何网址。前台本地只记录图片大小和哈希，不落盘图片。
- 历史图片（非最后一条）只保留 `kind=image` 与占位 content，不带数据；后台须视为“未看过”，不得声称看过。最新图片前台未能取到时不带 attachments，content 写“[图片，前台未取到]”；后台可回复请买家补发，不冻结会话。
- 仅 model 与 hybrid 模式会把 attachments 作为多模态图片输入交给已授权的模型链；rules 模式不调用模型，带图片的最新消息按未命中转人工。各模式共用的前置判断（店铺关闭、消息时间异常等）先于此执行，不会因有图片而强行调用模型；最新图片缺少数据时仍按上一条请买家补发。某模型接口实际不接受图片时按模型失败处理：先按现有主备策略尝试备用模型，主备均不可用时才转人工；不得假装理解。
- `card` 为纯文本结构：`type` 为 `goods` / `order` / `source` / `system`；`title`（不超过 500 字）、`description`（不超过 4000 字）可选；`fields` 最多 10 项，`label` 非空且不超过 20 字，`value` 不超过 200 字；任何字段不得含 URL。缺失时不传，content 仍须是可读描述。平台来源卡片与系统提示卡片为 `role=system, kind=card`，type 分别为 `source` / `system`。

### 订单、物流与备注（1.0 补充，只读）

`context` 可带可选字段 `orders`，是前台从本店已登录平台页面**自身已加载的数据**中读到的该买家订单摘要；前台不主动调用订单接口、不伪造风控参数。旧客户端不传时行为不变。

```json
"orders":[{"order_ref":"o-1","status":"已发货","goods_title":"示例商品","sku":"示例规格","quantity":1,
  "amount":"19.90","order_time":1790000000,"shipping_time":1790003600,"receive_time":null,
  "after_sale":"无","note":"示例备注",
  "logistics":{"company":"示例快递","tracking_number":"示例单号","state":"运输中",
    "traces":[{"time":1790007200,"info":"示例轨迹"}],"observed_at":1790007900},
  "observed_at":1790008000}]
```

字段与类型（未列出的字段一律 400）：

| 字段 | 必填 | 类型与限制 |
|---|---|---|
| `order_ref` | 是 | 非空字符串，≤200 字符，数组内唯一；前台生成的对话内引用（不是平台订单号），同一订单在同一对话中保持不变 |
| `observed_at` | 是 | Unix 秒（数字）；该订单摘要**实际从页面读到**的时间 |
| `status` `goods_title` `sku` `amount` `after_sale` | 否 | 字符串，≤200 字 |
| `note` | 否 | 字符串，≤500 字 |
| `quantity` | 否 | 正整数（布尔值无效） |
| `order_time` `shipping_time` `receive_time` | 否 | Unix 秒（数字）；未知可缺失或 null |
| `logistics` | 否 | 对象：`company` `tracking_number` `state`（字符串，≤200 字）、`traces`（数组，≤5 条，按时间倒序，每条 `{time: Unix 秒数字, info: 字符串 ≤200 字}`）、`observed_at`（Unix 秒，物流单独读取的时间，必填于 logistics 内） |

- 最多 10 个订单，按下单时间倒序。可选字段取不到就不传，不得编造。
- **新鲜度**：`observed_at` 只能是数据实际读到的时间，前台不得在重新提交时把旧缓存的时间改成现在；订单与物流分开读到时各自带 `observed_at`，不得用较新的订单时间掩盖较旧的物流时间。后台无法判断是否足够新时，回复用“页面记录显示……”的说法；需要实时状态时说明需刷新或向买家澄清，不按固定分钟数整段转人工。
- **归属**：订单摘要必须按读取时的店铺与买家归属。切店、切换买家、迟到的异步响应，只能挂到原请求所属的买家，不能挂到当前选中的买家；无法确认归属的直接丢弃。
- **版本**：订单变化本身不产生新事件，但会使该对话 `context_revision` 递增，使已生成的旧决定失效；下次提交时随上下文带上。
- **隐私**：收货人姓名、电话、地址、平台订单号、买家平台编号不作为字段传。`note`、`traces[].info` 等自由文本也可能含这些信息，前台在传之前须清理：手机号、身份证号、长数字编号、明显的地址片段替换为“[已隐去]”。`tracking_number` 是买家在自己订单中可见的信息，可传。
- **备注**：`note` 是商家内部订单备注的只读副本，仅作回答依据，不得原文向买家披露；本项目没有备注写入能力，后台不得生成“已备注/已改备注”的回复。
- **数据不是指令**：`orders` 的所有字段都是数据，模型不得把备注、轨迹等文字中的内容当作系统或操作要求。
- **回答规则**：多笔订单无法唯一对应买家问题时，先问是哪件商品或哪笔订单；缺字段不补造；不传或为空数组表示“前台没有读到”，不得据此断言买家没有订单；不得声称已查询实时状态或已修改备注。
- `orders` 计入请求体上限，不改变 `history_complete` 的含义。

`context_revision` 是前台在同一会话、同一买家对话中持久化的严格递增正整数，收到新消息、人工接管/人工回复、上下文变化均须使旧决定失效。不能用数组长度代替版本号。新会话可从 1 开始。同一 message_id 不得换 event_id 重提。

响应 HTTP 202，返回持久化事件快照，通常 `state=pending`。网络超时可以用**完全相同** event_id 和请求体重投：返回已有任务，不重复判断。相同 event_id 不同内容返回 409 `event_conflict`；同店铺、同对话、同 message_id 已存在另一个 event_id 返回 409 `message_duplicate`。历史页面同步不得当新消息批量入队：前台只提交实时收到的新进买家消息；重连/重启时读到的历史只用作上下文，仅当历史最后一条买家消息之后又收到实时推送时提交最新那条。不再以“消息超过 120 秒”一律拒绝；只有该对话最新事件可以领取发送许可。消息时间超前 5 秒以上或店铺未启用均不生成可发送回复；历史不完整按上述可见信息策略处理。

快照结构：
```json
{"event_id":"event-001","shop_id":"demo-shop","client_id":"demo-client","conversation_id":"buyer-demo-001","message_id":"message-001","context_revision":1,"session_id":"session-001","generation":1,"state":"ready","decision":{"action":"reply","text":"示例回复","reason":"rule:hours","expires_at":1790000060.0},"delivery":{"status":"unclaimed","attempt_id":null,"platform_message_id":null},"created_at":1790000000.0}
```

`decision` 在 pending 时为 null；action 为 reply/handoff/none。handoff 是交人工处理建议，**不代表后台已经操作平台转接**。state 为 pending/processing/ready；只有 ready+reply 才可能请求发送许可。后台内部失败产生 handoff。后台重启遗留的任务按以下规则处理，不再一律转人工；启用契约 A 后，带预算事件还须先满足 A.6 的截止恢复规则，不能借重判刷新预算：
- 仅 state 为 pending/processing 且 `delivery.status=unclaimed` 的任务，在**原 client + instance + session** 重新心跳后重新判断；保持原 generation 与原请求内容/摘要，仍须满足最新消息、版本与上下文检查。
- 若重新心跳的是其他 instance 或 session，旧任务结束为 `action=none`（superseded），不再判断。
- 已 ready 的既有判断结果不重算。
- 未完成的 claim 归为 unknown，已存在的 unknown 不变；二者都永不重发、不重新判断。

## 3. 读取判断

`GET /api/v1/events/{event_id}`，原客户端 token；其他客户端/店铺看不到任务。pending/processing 时建议 0.5–1 秒轮询，网络失败指数退避。回复有效期最多 60 秒，取回晚了不能发。

## 4. 发送前最后一次核验

先在前台确认：当前登录店铺、会话、连接、上下文版本、最新消息和人工接管状态均有效；早期历史可不完整，但本次可见上下文须属于当前目标。再发：

`POST /api/v1/events/{event_id}/claim`
```json
{"instance_id":"instance-001","session_id":"session-001","generation":1,"attempt_id":"attempt-001"}
```

后台核验有效租约、最新消息/版本、回复有效期、店铺当前启用状态及设置版本、一单一发送尝试，成功返回更新后的事件快照及 `delivery.status=claimed, delivery.claim_expires_at`（10 秒）。启用契约 A 后，预算事件还须满足 A.4 的截止核验；已领取 attempt 的重复查询不刷新预算或许可。许可只适用于该事件原文，前台不得改写判断文案。**发送前还必须在本地重新检查新消息和人工状态，并先持久化发送尝试**；服务端许可无法消除平台与后台间的竞态。

首次 claim 后该事件不再分配第二个发送尝试。重复相同 attempt_id 可查询原许可；它绝不表示可以再次调用平台发送。claim 响应丢失可先查询任务，仅当前台日志明确证明从未开始平台请求且许可仍有效时继续首次发送；否则 unknown。claim 超时或后台重启，未完成的 claim 归为 unknown。店铺/会话/上下文失效均返回 409。客户端不可因后台无响应而本地判断并自动回复。

## 5. 回执

`POST /api/v1/events/{event_id}/receipt`
```json
{"attempt_id":"attempt-001","status":"sent","platform_message_id":"platform-message-001"}
```

status 只能 sent/not_sent/unknown。sent 必须具有平台明确成功回执与非空 platform_message_id；HTTP 200 或传输 ACK 不能冒充平台确认。只有确定没有调用平台发送时才使用 not_sent；发送后超时、丢失回执、崩溃均 unknown。回执可以原样重复上报；相互矛盾的回执 409。unknown 永久保留，后续 sent/not_sent 不覆盖；该事件不能再次 claim、永不重发，也没有清除或自动重发接口，并提示人工核查。unknown 只锁定该条事件，不冻结整个对话：同一买家之后的新消息作为新事件照常判断与发送（仍受租约、最新消息、版本、时效、店铺开关等全部检查）。回执上报失败时本地持久化待上传，但不得重发买家消息。sent 只是客户端报告的平台发送确认，不等于真实业务问题已解决。

## 聊天页附加发送（1.1 草案，双方审查通过前不生效）

在文字回复之外，允许后台决定发送店铺在平台上**已有**的三类内容：商品说明书、商品卡片、视频库视频。图片在平台上只能本地上传，本版本不支持；邀请下单、改价、申请售后、备注不在本版本。本段生效后，上文“action 为 reply/handoff/none”“只有 ready+reply 才可能请求发送许可”在**双方确认支持 send_item** 时扩展为“reply/handoff/none/send_item”“ready+reply 或 ready+send_item”；未确认时仍按原文。

### 能力协商

- 心跳请求可带可选字段 `capabilities`（字符串数组，最多 10 项，每项 ≤32 字符，不重复）。本段定义 `"send_item"`；独立能力 `"reply_deadline"` 见下文“契约 A”，该扩展当前尚未启用。
- 心跳响应带 `capabilities`：服务端支持且客户端声明了的能力交集；旧后台不返回该字段，视为空。
- 能力以**最近一次成功心跳响应**为准，按 instance + session + generation 绑定；租约变化后须重新确认。
- 同一租约续租时能力被撤回（响应不再含 `send_item`）：在途判断不得产出 send_item；已生成的 send_item 不能再领取许可（claim 返回 409）；客户端点击前发现能力已撤回则不点击，按 `not_sent` 处理。已开始平台发送的事件只收集本次结果，绝不因能力变化重发或改写 unknown。
- 仅当本租约已确认 `send_item` 时：客户端才可在上下文中带 `send_options`，后台才可返回 `action=send_item`。未确认时后台只返回旧 action；客户端收到不认识的 action（或未确认能力却收到 send_item）一律不执行、不 claim，本地按 none 记录。
- 兼容组合：旧客户端 + 新后台（不声明能力 → 不出现 send_item；新后台对未确认能力的事件中的 `send_options` 返回 400）；新客户端 + 旧后台（响应无 `capabilities` → 客户端不传 `send_options`，旧后台不会产生 send_item）。

### 候选（前台提交）

`context.send_options` 是前台在**本店已登录平台页面、该买家对话中**读到的本次可选发送对象。后台只能从本事件的候选中选择。

```json
"send_options":{
  "instructions":[{"option_id":"i-1","goods_title":"示例商品","name":"示例说明书","observed_at":1790000000}],
  "goods":[{"option_id":"g-1","goods_title":"示例商品二","observed_at":1790000000}],
  "videos":[{"option_id":"v-1","name":"示例视频","duration":30,"observed_at":1790000000}]}
```

| 字段 | 必填 | 类型与限制 |
|---|---|---|
| `send_options` | 否 | 对象；只允许 `instructions` `goods` `videos` 三个键，均可省略；省略或空数组都表示“前台没有读到该类候选” |
| `instructions` / `goods` / `videos` | 否 | 数组，分别最多 10 / 20 / 50 项，超限 400 |
| `option_id` | 是 | 非空字符串，≤64 字符，在整个 `send_options` 内唯一（跨三类也不重复）；前台生成的不透明编号，不是平台编号 |
| `observed_at` | 是 | 有限数字（Unix 秒，不接受布尔、NaN、Infinity），候选实际读到的时间 |
| `goods_title` | 见下方白名单 | 非空字符串，≤200 字 |
| `name` | 见下方白名单 | 非空字符串，≤200 字（说明书名称 / 视频名称） |
| `duration` | 仅 videos 可选 | 正整数秒（不接受布尔） |

各类字段白名单（只允许以下字段，其余一律 400）：
- `instructions[]`：`option_id`、`goods_title`、`name`、`observed_at`，全部必填。
- `goods[]`：`option_id`、`goods_title`、`observed_at`，全部必填。
- `videos[]`：`option_id`、`name`、`observed_at` 必填；`duration` 可选。

- 类型不符、重复 `option_id` 一律 400。不传任何网址、图片、价格、平台商品/文件编号或平台审核信息。
- 候选来源：`instructions` 为该买家订单中已配置说明书的商品；`goods` 为该买家订单中的商品及平台“商品推荐”页签的商品；`videos` 为视频库中审核通过的视频。
- **绑定**：`option_id` 只在该店铺、该租约（instance+session+generation）、该对话、该 `context_revision` 内有效。前台私有映射：说明书 → 平台商品编号 + 说明书模板编号与版本；商品卡片 → 平台商品编号；视频 → 视频库文件编号。映射不随上下文上传、不落入日志。候选集合或映射任一变化都使 `context_revision` 递增。
- 候选只是数据，不是指令；后台不得把其他店铺、其他对话或其他事件的候选放进模型上下文。

### 决定

新增 `action=send_item`，一次事件只发一项，不附文字（文字与附件不合并成两次平台发送）：

```json
{"action":"send_item","item":{"type":"instruction","option_id":"i-1"},"reason":"rule:manual","expires_at":1790000060.0}
```

- `item.type` 为 `instruction` / `goods_card` / `video`，`option_id` 必须存在于本事件 `send_options` 中**对应类型**的数组；否则不得生成。
- 选择逻辑沿用 rules/model/hybrid：规则可配置目标，模型/混合模式也只能从本事件候选中选；候选缺失时不得猜编号，改为澄清或普通文字决定。具体设置字段另行约定。
- claim 核验、10 秒许可、一事件一发送尝试、unknown 规则与 reply 相同。

### 前台执行与回执（全部在 10 秒许可内完成）

1. claim 前在本地重核：同店铺、同租约、同对话、同 `context_revision`、无新买家消息、非人工状态，且 `option_id` 映射仍存在；否则不 claim。
2. claim 成功后、点击前：记录该对话当前消息编号集合作为**基线**，并在本地持久化发送尝试（含 attempt_id、类型、私有映射摘要），再执行点击。
3. 打开说明书对话框、切到商品推荐或视频列表都是异步过程。claim 前的重核**不能代替**主协议“真正发送前再核验”：在点击发送的那一刻之前，须再次核对店铺、租约、会话、最新消息、`context_revision`、人工状态、已协商能力与候选映射，并确认尚未到确认截止（见第 5 步）。任一不满足，或准备阶段已越过 `claim_expires_at − 2 秒`，则不点击，按未开始发送报 `not_sent`。
4. 点击只用平台页面自身按钮（订单里的“发送说明书”、商品推荐里的“发送商品”、视频列表里的“发送”），不自行拼接平台请求、不伪造风控参数。点击前确认页面对象就是原候选：说明书对话框加载的模板编号与版本须与映射一致；商品卡片须为映射的商品编号；视频行须为映射的文件编号（不能只比名称）。不一致则关闭对话框、不点发送，回执 `not_sent`。
5. **确认截止 = claim_expires_at − 2 秒**（留出回执上报时间）。截止前须同时满足才报 `sent`：
   - 平台该发送接口明确返回成功；
   - 该对话相对基线**恰好新增一条**本店客服方向、对应类型的消息，且其内容能对应到目标对象（商品/说明书/视频身份一致）；该消息的平台编号作为 `platform_message_id`。
6. 截止前任一条件不满足，或同期出现多条同类型新增消息无法唯一对应、或对象不一致，一律报 `unknown`；不重发、不覆盖、只锁定该事件，同一买家后续新消息照常处理。前台尚未点击发送即中止的，报 `not_sent`。
7. 本版本不延长许可、不改变 unknown 状态机；若实测 8 秒内无法稳定完成确认，再另提状态机变更。

### 测试要求（实现阶段）

至少覆盖：能力协商四种组合（新旧客户端 × 新旧后台）、未确认能力时的 `send_options` 与 `send_item`、字段校验（必填、类型、上限、重复、未知字段）、无效或跨类型 `option_id`、跨店/跨会话/旧 revision 候选、许可第 10 秒边界与截止后确认只能 unknown、对象不一致或多条同类型新增消息不得报 sent、等待对话框/列表期间来了新消息或切换买家或越过确认截止时不点击并报 not_sent、决定生成后同一租约撤回能力（在途判断、claim、点击前三处）。

## 商品快照（1.2 草案，双方审查通过前不生效）

让后台知道本对话涉及哪些商品，以及前台是在哪里、什么时候读到的，便于按商品匹配店铺规则和本地资料。商品快照**不是价格、库存或优惠的来源**。数据只取本店已登录平台页面**自身已加载的数据**；前台不主动打开商品页、不调用商品接口、不读 Cookie。

### 能力协商

- 心跳 `capabilities` 新增能力名 `"goods_snapshot"`，规则与 `send_item` 相同：以最近一次成功心跳响应为准，与 instance + session + generation 绑定。
- 仅当本租约已确认 `goods_snapshot` 时，前台才可在上下文中带 `context.goods` 和 `orders[].items`；未确认时后台对这两个字段返回 400。
- 兼容组合：
  - 旧客户端 + 新后台：不声明能力，就不带这两个字段，行为不变。
  - 新客户端 + 旧后台：响应里没有该能力，前台不带这两个字段。

### 商品条目的身份（`goods_ref`）

- 每个条目有一个**来源身份**：
  - 读到平台商品编号时，身份就是这个编号；
  - 读不到编号时，身份就是完全相同的标题。
- `goods_ref` 由店铺、对话和来源身份经摘要生成，**在同一对话内不随 `context_revision` 变化**：同一来源身份在任何一次提交里引用都相同。
- 平台商品编号不上传，也不出现在 `goods_ref` 中。
- 前台**不把“有编号”和“只有标题”两种身份合并**，即使标题相同、当前集合里恰好只有一个同名编号也不合并。因此：
  - 两个条目标题相同，可能是同一件商品，也可能不是；
  - 后台不得据此认定它们是同一件，也不得认定它们不是同一件；
  - 需要区分时，向买家确认。
- 同一编号的商品改了标题时，`goods_ref` 不变，`title` 取最近一次读到的标题。

### `context.goods`

```json
"goods":[{"goods_ref":"g-1","title":"示例商品","evidence":[
  {"source":"order","order_ref":"o-1","observed_at":1790008000},
  {"source":"goods_card","message_id":"message-007","card_price":"示例价格文字","observed_at":1790000310}]}]
```

| 字段 | 必填 | 类型与限制 |
|---|---|---|
| `goods` | 否 | 数组，最多 10 项，按各项最新 `evidence.observed_at` 倒序；省略或空数组表示“前台没有读到”，不表示买家没有涉及商品 |
| `goods_ref` | 是 | 非空字符串，≤64 字符，数组内唯一；生成规则见上文“身份” |
| `title` | 是 | 非空字符串，≤200 字，不含网址 |
| `evidence` | 是 | 数组，1–5 项，按 `observed_at` 倒序，同一 `order_ref` 或同一 `message_id` 只出现一次；每项是读到该商品的一处来源 |
| `evidence[].source` | 是 | `order`：该买家的某笔订单里有这件商品；`goods_card`：本对话某条消息是这件商品的卡片 |
| `evidence[].observed_at` | 是 | 有限数字（Unix 秒）。`source=order` 时**等于**该订单摘要的 `observed_at`（实际从页面读到的时间）；`source=goods_card` 时**等于**该消息的 `created_at`（卡片展示价对应的时刻） |
| `evidence[].order_ref` | `source=order` 时必填，其他来源不得出现 | 须等于本上下文 `orders[].order_ref` 之一，且该订单的 `items` 里有引用本条目 `goods_ref` 的明细 |
| `evidence[].message_id` | `source=goods_card` 时必填，其他来源不得出现 | 须等于本上下文 `messages[].id` 之一；该消息须为 `kind=card`、`card.type=goods`，且 `card.title` 等于本条目的 `title` |
| `evidence[].card_price` | 仅 `source=goods_card` 可选 | 卡片上显示的价格文字（≤200 字），即**卡片发出时的展示价** |

- 未列出的字段一律 400。各来源只允许上表列出的字段，字段与来源不匹配（例如 `source=order` 却带 `card_price`）也返回 400。
- 规格和件数**只放在订单明细 `orders[].items` 里**，不放在 `evidence` 中：同一订单里同一件商品可能有多个规格，`evidence` 只说明“这笔订单里有这件商品”。

### `orders[].items`

订单摘要增加可选字段 `items`，数组，1–5 项，是该订单的商品明细：

```json
{"order_ref":"o-2","goods_title":"示例商品","sku":"示例规格","quantity":1,"items":[
  {"goods_ref":"g-1","goods_title":"示例商品","sku":"示例规格","quantity":1},
  {"goods_ref":"g-1","goods_title":"示例商品","sku":"示例规格二","quantity":2},
  {"goods_title":"示例商品三"}],"observed_at":1790008000}
```

- 按页面订单里的顺序，列出前 5 条明细，**不因 `goods` 的 10 项上限而删减**。
- 每项字段：
  - `goods_title`：必填，≤200 字；
  - `sku`：可选，≤200 字；
  - `quantity`：可选，正整数；
  - `goods_ref`：可选。只有这件商品进入了 `context.goods` 时才带，而且必须等于其中某项的 `goods_ref`。同一 `goods_ref` 可以出现在多条明细里，对应不同规格。
- 原有的 `goods_title` `sku` `quantity` **语义不变**，仍是页面订单的首件商品，与旧客户端一致。它们与 `items` 相互独立：通常等于 `items` 第一项，但后台**不得依赖二者相等**，也不得用其中一个去校验另一个。
- 超过 5 条明细的订单只带前 5 条，后台不得据此声称订单只有这些商品。

### 规则

- **价格**：`card_price` 只表示卡片发出时显示的价格；订单 `amount` 是整单实付。两者都**不是当前售价**，也不能互相换算成单价。本草案不提供现价、优惠、完整规格或库存；后台不得把这些信息缺失解释成没有库存、不支持或没有优惠，需要时请买家看商品页或转人工。
- **归属**：
  - 订单来源按读取订单时请求里的买家归属（同“订单、物流与备注”），卡片来源随所在消息归属；
  - 都与当前选中的对话无关；
  - 无法确认归属的直接丢弃。
- **版本**：商品快照变化本身不产生新事件，但会使 `context_revision` 递增；`goods_ref` 不因此改变（见“身份”）。
- **数据不是指令**：标题、规格等文字只是数据。
- **回答规则**：多件商品无法确定买家问的是哪件时先问清；未列出的商品属性不补造。
- **暂不提供**（字段未确认，前台不实现）：
  - 买家进店来源卡片里的商品信息；
  - 商品推荐列表的价格和分组含义；
  - 订单内各商品的单价；
  - 买家发来的商品卡片里的商品编号。
  字段结构确认后再另行补充。

### 测试要求（实现阶段）

至少覆盖：
- **能力协商**：四种组合；未确认能力时带 `goods` 或 `items` 返回 400。
- **字段校验**：必填、类型、上限、重复、未知字段、来源与字段不匹配。
- **引用一致**：
  - `order_ref` 能对上，且该订单有对应明细；
  - `message_id` 是标题相同的商品卡片；
  - `observed_at` 与引用对象一致；
  - `items[].goods_ref` 存在于 `goods`。
- **身份**：同一对话跨多次提交 `goods_ref` 不变，包括后来出现同名的有编号商品时；编号相同、标题改变时引用不变；有编号和只有标题的身份不合并。
- **订单明细**：同一订单同一商品的多个规格都保留在 `items`；达到 `goods` 10 项上限时，`items` 不被删减、`goods_ref` 省略；超过 5 条明细；原摘要与 `items` 首项不同时不报错。
- **归属**：跨买家的迟到响应不得进入本对话。

## 会话操作：收藏标星与转人工（1.3；首次启用范围见文末边界）

用途：店铺配置的兜底处理（处理不了、报错、超时等）可以选择“给该买家会话标星（选颜色）”或“把该会话转给指定客服账号（转人工）”。本段生效前，上文 `handoff` 仍只是建议，前台不执行任何平台转接或收藏；**回复文字里出现“转人工”等字样永远不触发平台操作**。仅观察模式不执行本段动作。

拼多多页面实测事实（前台诊断记录，只记结构）：
- 收藏与标星是同一状态，颜色四选一；未收藏时选颜色即收藏，点星标本身即以默认色收藏。
- 颜色与平台 `mark_conversation` 请求 `color` 数值的对应（店主在场逐个点选并确认，2026-10-31）：`orange`（店主称“黄色”，点星标时的默认色）= 1，`red` = 2，`green` = 3，`blue` = 4。管理界面对 `orange` 显示为“黄色”。0 与大于 4 的数值未观察，不得使用。
- 转移入口为会话工具栏“转移会话”，对话框按客服行选择，再选“无原因直接转移”（另有原因项与“发送”，前台不点）。
- **已收藏的会话不可转移**：平台返回失败并给出“取消收藏并转移 / 暂不转移收藏会话”。页面在“取消收藏并转移”后依次发出 `unmark_conversation`、`move_conversation`，随后页面自行发出 `close_conversation`（前台不主动调用该接口，其作用对象与必要性待核实）。
- 平台响应字段语义（`result.result`、`error_code` 等）尚未核实；核实前不得据此判定成功。

### 能力协商（按账号转接增量，2026-11-07）

- 心跳使用两个独立能力名 `"mark_conversation"` 与 `"transfer_by_account"`，规则与 `send_item` 相同：以最近一次成功心跳响应为准，与 instance + session + generation 绑定；租约变化重新确认；撤回后在途判断不得产出、已生成的不能 claim、点击前发现撤回则不点击报 `not_sent`。
- `transfer_by_account` 表示后台在决定中下发已保存的完整接收账号，前台只在领取该转接决定后打开平台转接窗口并精确匹配。转接确认后满足下文“转接完成判据”即报 `sent` 并完结，不能只凭点击命令或孤立的页面状态报成功。
- 本增量替换旧 `transfer_conversation` 的预采集/目标编号方案。新后台不确认旧能力，新客户端不声明旧能力；新旧组合未确认 `transfer_by_account` 时不生成或执行按账号转接。客户端拒绝旧 `target_id` 格式，不把它猜成账号。客户端与后台均更新后新能力才生效，已保存的账号和取消收藏策略不自动更改。
- 未确认标星能力时，事件携带 `conv_state` 返回 400；转接能力不再要求该字段。客户端收到不认识的 action 按 none 记录；格式合法但能力未确认的动作保留用于展示，不 claim、不执行。

### 前台提交（`context`）

```json
"conv_state":{"marked":true,"color":"red","observed_at":1790000000}
```

| 字段 | 必填 | 类型与限制 |
|---|---|---|
| `conv_state` | 仅确认 `mark_conversation` 时必填 | 对象，只允许下列三键 |
| `conv_state.marked` | 是 | 布尔或 null；null 表示本次没有可靠读到 |
| `conv_state.color` | 是 | `red`/`orange`（界面显示“黄色”）/`blue`/`green` 或 null；`marked` 为 false 或 null 时必须为 null，`marked=true/color=null` 只表示已收藏但颜色未知 |
| `conv_state.observed_at` | 是 | 有限数字（Unix 秒） |

- 标星状态取不到时如实上报 `marked=null`，不得捏造 false，也不得丢弃事件。此时后台不生成 mark，正常 reply / send_item / handoff 流程照常。
- **转接不预采集接收人名单，不提交 `transfer_targets`，不依赖事件中的收藏状态。** 即使所有店铺策略已经配置接收账号，普通消息准备阶段也不打开转接弹窗。收藏状态留到实际执行时在本会话核对，未知则不点击并报 `not_sent`。
- 不上传客服状态数值（语义未知，不推断在线）、备注、接待量或任何平台账号编号。

### 接收人

- **接收人身份 = 转移会话对话框第一列“账号名”。** 店主确认（2026-11-01）：该列账号名在平台上不能修改；昵称和备注都不作身份依据。用户 2026-11-07 明确要求后台决定转接后，前台按已配置账号直接定位执行，不提前采集整张名单。
- 后台从已保存规则或兜底策略生成 `transfer.account`，去首尾空白后 1–40 字。账号不由模型生成、不进入模型请求。生成决定和 claim 都核对策略来源、账号、取消收藏权限及设置版本，不允许把账号换成另一个目标。
- 前台执行时打开当前买家的转接弹窗，读取第一列完整账号名（不截断），按 `transfer.account` **完全相等**匹配，恰好一行且有唯一可点击“转移”按钮才继续。不按第一行、昵称、备注、包含或前缀关系匹配。
- 账号缺失、重名、按钮不可用或名单加载失败时，保留原 transfer 决定，明确记录本地原因（如 `transfer_target_missing`、`transfer_target_ambiguous`），回执 `not_sent` 且省略步骤，顶层 reason 按现有封闭枚举归类。不能静默改成后台 handoff，也不能猜接收人。名单加载及所有核对仍受原事件预算和领取许可约束，不另开新的20秒预算。
- 点击目标行前最后一次页面快照同时核对唯一买家、唯一账号行与命中点；之后页面或登录归属变化、列表重排、外来输入均停止。已经尝试行或确认点击但不能满足完成判据时保留 unknown，不补做。
- 转接结果按下述完成判据处理；标星的独立成功判据与 unknown 规则不随此次调整改变。

### 转接完成判据（2026-11-07）

用户现场确认：目标会话离开当前会话列表，且接收端已收到该会话；明确要求转接完成后直接显示成功并完结。本增量采用以下自动完成判据：

1. 后台指定的完整账号已唯一匹配，前台已对该账号执行“无原因直接转移”确认，点击命令已派发；不以打开弹窗或只点目标行作为完成。
2. 同一页面、平台店铺、会话归属与授权仍有效，无外来输入或页面/登录变化，决定和许可确认期限未到；页面没有转移失败框。20秒仍只限制开始动作，已确认后的结果观察可以跨过该起始预算，但不延长原许可确认期限。
3. 确认之后重新读取非空会话列表，所有列表键可解析，原买家已不在列表中。空列表可能正在刷新/加载，不能单独判成功；读取失败、会话仍在、资格失效或超时保留 unknown，不重试。
4. 满足以上条件返回 confirmed，持久化为 sent，回执步骤为 `transfer:sent`、`page_observed=left_list`，省略平台消息编号；界面直接显示“转接成功”“会话已转交，处理完成”。后台保留终态、拒绝再次领取；客户端重复发现或重启后不再执行该事件，后续新消息仍按正常规则处理。
5. 已授权“取消收藏并转移”时，先持久化组合动作意图，再派发平台唯一组合按钮；只有该按钮已派发且随后满足同一会话离开列表判据，才将第二步报 `unmark_and_transfer:sent/unmarked=true`，整体 sent。本次组合按钮之后，同一页面、同一买家的第一条取消收藏请求不作为外来标星变化；其他目标、其他页面或重复请求仍使完成资格失效。命令异常、拒绝、超时或未观察到完成均保留 unknown/unmarked=null，不补点、不恢复收藏。
6. 本规则用于本次新执行的完成判定，不扫描或重写既有 unknown；已写入 unknown 的历史事件仍按原审计规则保留，不接受迟到 sent 覆盖。

### 决定

新增两个 action，一次事件一项，不附文字：

```json
{"action":"mark","mark":{"color":"red"},"policy_version":3,"reason":"fallback:model_timeout","expires_at":1790000060.0}
{"action":"transfer","transfer":{"account":"主账号","unmark_policy":{"allow":true,"version":3}},"policy_version":3,"reason":"fallback:unhandled","expires_at":1790000060.0}
```

- `mark.color` 四选一。**本阶段只对未收藏的会话生成 mark**（本事件 `conv_state.marked === false`）；已收藏（无论颜色是否已知）或 `marked=null` 都不生成 mark，按策略改为 `handoff` 建议或 `none`。给已收藏会话改色，以及颜色读取，须另行取证后再补入（见下文“标星执行与成功判据”）。两种新动作都省略 `text`，携带正整数 `policy_version`，等于本事件冻结的店铺设置版本；`transfer.unmark_policy.version` 也等于该版本。设置变化后旧决定不得提交或首次 claim。
- 一事件一动作：不组合“先发文字再转人工”，也不组合“先标星再转移”。店铺兜底配置对每类情形（`unhandled` 无法处理 / `error` 报错 / `model_timeout` 模型超时）各选一种：不处理、handoff 建议、mark（选颜色）、transfer（填接收人账号名）——四者互斥；规则与话术共用同一套结构化处理方式，配置带店铺策略版本，决定里携带该版本，版本变化后旧决定 claim 409。
- **超时边界。** `fallback:model_timeout` 只指“在事件既有预算内、模型调用超时后的兜底”：它是普通决定，照常受 `expires_at`、claim 许可和契约 A 预算约束，不重置或延长任何预算。总预算已耗尽的事件按契约 A 以 `handoff` + `reply_deadline_exceeded` 终结，**不可复活、不可 claim，也不生成 mark/transfer**；若以后要求预算耗尽后仍自动转人工，须另定独立的动作时限与归属，并重新审查。
- `transfer.unmark_policy` 是店铺**一次配置的固定策略**及其版本：`allow=true` 表示“遇平台以已收藏为由拒绝转移时，取消收藏后再转一次”；未配置视为 `allow=false`。前台只按决定里携带的策略执行，不自行放宽。策略版本变化后，旧版本的决定不能 claim（409）。
- claim 核验、10 秒许可、一事件一尝试、unknown 规则与 reply 相同；claim 额外核验能力与（transfer 时）策略版本。

### 前台执行

1. claim 前后与点击前的重核同 `send_item` 第 1–3 步。mark 继续核对本事件 `conv_state`；transfer 按决定中的完整 `account` 在执行时核对本店铺、当前买家、收藏状态和唯一目标行，不依赖预采集名单或旧页面映射。
2. 每个平台写入步骤之前先本地持久化该步尝试（attempt_id + 步骤名），再点击；只点平台页面自身按钮，不拼接平台请求。
3. **mark**：只点星标颜色浮层中的目标颜色项（不点星标本身；浮层须可证明属于当前会话星标）。
4. **transfer**：点“转移会话”→ 以账号名核对的目标行“转移”→“无原因直接转移”。若平台以“已收藏”拒绝：
   - `allow=false`：执行前已知收藏时不开始动作，回执 `not_sent`（reason `blocked_by_mark`）；若是在尝试点击后平台才以收藏拒绝，只点“暂不转移收藏会话”，保留本次 `unknown`，不取消收藏。
   - `allow=true`：点“取消收藏并转移”。
   - 平台的“取消收藏并转移”是**一次页面点击**，页面随后自行发出取消收藏与再次转移两个请求；前台把它记为一个步骤 `unmark_and_transfer`，不拆成两次点击。
   - 任一步结果不明即停止，不补做后续步骤，不把未知当失败重来；不自动恢复收藏，不重试。
5. **确认截止 = claim_expires_at − 2 秒**。

### 回执

沿用 `status: sent/not_sent/unknown`，`sent` 表示平台写入已确认。**mark/transfer 不发聊天消息，回执不带 `platform_message_id`（必须省略或为 null）**：主协议“sent 必须有非空 platform_message_id”只适用于 reply/send_item，本段动作以下列 `steps` 与成功判据代替，前台不得编造消息编号。另带：

```json
{"attempt_id":"attempt-001","status":"unknown","steps":[{"step":"transfer","status":"not_sent","reason":"blocked_by_mark"},{"step":"unmark_and_transfer","status":"unknown","unmarked":null}],"page_observed":"left_list"}
```

- `steps` **只列已开始的步骤**（已持久化尝试并点击，或平台已对其明确答复）；未开始的步骤省略，不用 unknown 占位。
- 步骤状态：`sent` 平台明确成功；`not_sent` 平台明确拒绝或未点击；`unknown` 已点击但结果不明。`unmark_and_transfer` 另带 `unmarked`：`true` 收藏已确认被取消，`false` 确认未取消，`null` 不明。
- **mark** 只有一个步骤 `mark`（带 `color`）：`mark`=sent → 整体 sent；not_sent → not_sent；unknown → unknown。示例：`{"attempt_id":"attempt-002","status":"sent","steps":[{"step":"mark","status":"sent","color":"red"}],"page_observed":"marked"}`。
- **transfer** 整体聚合（只看**最后一个转移步骤**是否确认成功）：

| 情形 | 整体 status | 说明 |
|---|---|---|
| `transfer`=sent | sent | |
| `transfer`=not_sent(blocked_by_mark)，策略不允许 | not_sent | 收藏未改变 |
| `transfer`=not_sent(blocked_by_mark) → `unmark_and_transfer`=sent，`unmarked=true` | sent | 收藏已取消，属于策略预期 |
| `transfer`=not_sent → `unmark_and_transfer`=not_sent，`unmarked=true` | not_sent | **收藏已被取消但未转移**，管理界面须显示这一状态改变；不自动恢复收藏、不重试 |
| `transfer`=not_sent → `unmark_and_transfer`=not_sent，`unmarked=false` | not_sent | 状态未改变 |
| 任一步 unknown（含 `unmarked=null`） | unknown | 不重试、不补做 |
| `transfer`=unknown | unknown | 不再进行后续步骤 |

- 已领取但确定尚未开始任何平台步骤时，仅可提交 `status=not_sent`，`steps` 省略或为空；不能伪造未开始的步骤。`page_observed` 若提供，仅为 `marked` / `left_list` / `unchanged` / `unknown`，不参与聚合。回执顶层及步骤可选 `reason` 仅为 `blocked_by_mark` / `platform_rejected` / `conv_state_unavailable` / `conv_state_changed` / `capability_withdrawn` / `deadline_exceeded` / `not_started`，不得携带原始平台文字。
- 后台核验 `steps` 与冻结决定的颜色/取消收藏策略一致、顺序与上表一致，整体 `status` 必须等于聚合结果；无授权不得报告第二个 `unmark_and_transfer` 步骤。相同回执幂等，终态后的状态、步骤、观察或原因冲突返回409，unknown 不被晚回执覆盖。
- mark 的 `sent` 仍须满足其独立成功判据；transfer 的 `sent` 须满足上文“转接完成判据”，将指定账号确认点击与随后原会话离开列表结合核验。缺失或冲突保留 `unknown`。
- 孤立的 `page_observed` 元数据不自动提升为 `sent`，也不触发补做。transfer 只有在适配器完整核验上述动作与归属后才返回 confirmed，运行时再核对确认期限与会话身份并上传成功回执；标星仍保持原规则。
- 被明确拒绝的步骤永远不能聚合为 `sent`；transfer 的整体 `sent` 只来自最后一个转移步骤的明确成功，mark 的整体 `sent` 只来自 `mark` 步骤的明确成功。`steps` 只记步骤名、状态、`color`（仅 mark）与 `unmarked`，不含客服名、买家标识或平台原文。
- 后台按 `decision.action` 校验回执：mark/transfer 带非 null 的 `platform_message_id` 返回 400（省略或 null 允许）；`steps` 与 action 不匹配（如 mark 回执出现转移步骤）返回 400。
- unknown 规则同主协议：永久保留、不重试、不覆盖，只锁定该事件。

### 标星执行与候选成功判据（1.3 补充）

本节把上文 mark 的“前台执行”和“`sent` 须同时满足……（字段语义核实后补入判据）”具体化。依据是前台报告的单次人工样本（#18 评论 6541174020、6541614026）：默认色标星与取消收藏各一次，请求目标为当时唯一打开的会话；两层 `success` 为 `true`，`result.result` 为 `"ok"`，`result.request_id` 与请求一致。目前**没有失败样本**，也没有 2–4 号颜色的响应样本。所以下列判据只是候选：不符合的一律 `unknown`，不从中推出 `not_sent`；首轮真实验收须每种颜色至少覆盖一次，再决定是否修订。

**适用范围**
- 只执行 `conv_state.marked === false` 时生成的 mark。前台在 claim 之前就核对：决定所在事件提交的 `conv_state` 必须是 `marked=false`，否则不 claim（本地记为阻止，不上传回执）。
- 只点星标颜色浮层中的目标颜色项。不点星标本身，不点已勾选的颜色项，不做取消收藏。

**点击前核对**（任一不满足都不点击；已 claim 的回执 `not_sent`，`steps` 省略，`reason` 按下列取值）
1. 主协议与 `send_item` 第 1–3 步的重核全部通过：店铺与平台登录身份一致、租约与 `mark_conversation` 能力仍确认、同一 `context_revision`、无新买家消息、非人工接管、未过确认截止。不通过时 reason 为 `capability_withdrawn`、`deadline_exceeded` 或 `not_started`。
2. 页面代次（页面重载、切店、清理浮层都会使它变化）从开始核对到点击都没有变化。否则 reason 为 `conv_state_changed`。
3. 页面打开的会话按买家去重后恰好一个，且就是本事件的买家；同一买家同时出现在“待回复”和“全部”列表里算同一个。否则 reason 为 `conv_state_changed`。
4. 工具栏星标唯一，且当前**未收藏**：已收藏时 reason 为 `conv_state_changed`；星标缺失或不唯一时 reason 为 `conv_state_unavailable`。
5. 颜色浮层能证明属于这个星标：由星标（或其 4 层内的祖先或后代）的 `aria-describedby` 指向，可见、唯一、至少含三种已知颜色。目标坐标处的元素是浮层中颜色为目标色的列表项。证明不了时 reason 为 `conv_state_unavailable`。
6. 以上核对与点击之间，除了等待浮层出现、把鼠标移到目标项，不插入其他页面操作。
7. **操作独占、无人工输入**（见下文“来源绑定”）：从占用页面开始核对起，平台页面收到的每个输入事件都是前台本次自己发出的；页面没有发出任何标星/取消收藏请求；点击前 3 秒内页面也没有发出过此类请求（包括前台自己上一次标星）。否则 reason 为 `conv_state_changed`。
8. 平台仍登录、且登录店铺身份与开始核对时相同。否则 reason 为 `not_started`。

**请求核对（点击窗口）**
- 从点击前一刻到确认截止为“点击窗口”。窗口内，前台在请求阶段拦截页面发出的 `/plateau/chat/mark_conversation` 和 `/plateau/chat/unmark_conversation` 请求，规则如下：
  - **放行**：窗口内第一条 mark 请求，且同时满足：页面代次与点击时相同；`data.uid` 等于本事件买家（字符串严格相等）；`data.color` 等于决定颜色对应的数值（`orange`=1、`red`=2、`green`=3、`blue`=4，整数严格相等）；`data.request_id` 为有限数字。放行时记下该请求的浏览器请求编号（CDP `requestId`）和 `data.request_id`。
  - **拦截**：其余请求一律在发出前拦截，包括目标或颜色不符、第二条 mark、任何 unmark、页面代次已变。被拦截的请求不会到达平台。
- 窗口之外，以及没有进行中的 mark 时，页面请求（包括店主手动点星标）照常放行，不受影响。（点击前核对期间出现的此类请求虽照常放行，但按第 7 条使本次放弃点击。）

**来源绑定**（证明放行的那条请求来自本次点击）
- 放行请求“同买家、同颜色、编号一致”只证明目标与响应配对正确，不证明它是本次点击触发的：店主手动操作或页面延迟发出的旧请求可能恰好先到。前台以下列四项共同证明来源，任一项不能证明即 `unknown`（点击前发现则不点击，见第 7 条）：
  1. **操作独占**：从占用页面开始到点击窗口关闭，前台不做任何其他页面操作（发送、预热、清理浮层都互斥）。
  2. **无外来输入**：同一时段内，平台页面收到的每个输入事件（鼠标移动、按下、松开、滚轮、按键、触摸等）都必须能与前台自己发出的输入命令一一配对：在该条命令执行期间到达、事件类型对应（移动/按下/松开），且每条命令恰好一条。出现任何不能配对的输入（多出的、类型不对的、命令之外到达的），视为人工介入：点击前放弃，点击后 `unknown`。依据（前台在本机虚构页面上实测，客户端所用 Electron 版本）：经调试通道发出的每条鼠标命令，都在该命令返回之前产生恰好一条对应类型的页面输入事件；模拟的系统输入同样产生页面输入事件。事件坐标随页面缩放换算（例如缩放 1.25 时为命令坐标的 1.25 倍），所以坐标不作为配对依据。
  3. **点击前静默**：占用页面开始到点击前页面没有发出任何标星/取消收藏请求，且点击前 3 秒内也没有（含前台自己上一次标星）。
  4. **窗口内唯一**：点击窗口内页面只发出这一条标星/取消收藏请求。出现第二条（无论被拦截与否、无论先后），就不能证明哪一条来自本次点击，结果 `unknown`，即使放行的那条响应全部满足。
- **以上四项只是必要条件，不能单独证明“本次点击 → 该请求”。** 它们排除不了在静默期之前就已排队、尚未发出的异步写入（例如旧点击挂起的延迟请求）：本次点击恰好没有产生请求，而旧写入在窗口内发出唯一一条同买家同颜色请求并成功，四项全部成立。前台实测也不能用时间先后补足：调试通道点击触发的请求，有时在松开命令返回之前、有时在之后才被拦截到。**本阶段没有可核验的正向绑定依据，所以点击后一律 `unknown`**，不报 `sent`：四项与下列成功判据全部满足时，原因记为 `mark_binding_unproven`，只用于显示与统计；任一不满足按各自原因 `unknown`。日后若取得可核验的正向绑定依据（例如脱敏核实的请求发起调用链能区分本次点击处理与既有异步任务），须另行修订本节并经双方审查后，才允许报 `sent`。
- 页面或登录变化使本次确认资格失效：放行之后直到窗口关闭，页面代次变化、页面关闭、平台登录失效或登录店铺身份变化，都按 `unknown`。响应在读取前（加载完成时）和读取后各核对一次页面代次与登录归属；窗口关闭或资格失效后才到达的回调不得改写结论。

**成功判据**（候选；本阶段即使全部满足也只记 `unknown` / `mark_binding_unproven`，见“来源绑定”。正向绑定依据补入前不报 `sent`）
1. 窗口内恰好放行了一条请求（同上），且窗口内没有出现其他标星/取消收藏请求（来源绑定第 4 项）。
2. 用该请求的 CDP `requestId` 取到它自己的响应，不按到达顺序配对，并且在确认截止前取到。
3. 响应是 JSON 对象，且：
   - 外层 `success === true`（严格布尔）；
   - `result` 是对象，`result.success === true`（严格布尔）；
   - `result.result === "ok"`；
   - `result.request_id` 是有限数字，且与放行请求的 `data.request_id` 严格相等。
4. 来源绑定四项全部成立；从放行到窗口关闭，页面代次与平台登录店铺身份都没有变化，响应读取前后的核对都通过。
- 其余情况都是 `unknown`，不重试，也不补做取消收藏或改色。包括：点击后窗口内没有放行任何请求（例如页面没有发出请求，或只发出了被拦截的请求）；窗口内出现第二条标星/取消收藏请求；窗口内出现人工输入；放行后或读取响应期间页面重建、平台登录失效或换店；响应加载失败、超时、不是 JSON；字段缺失或类型不符；`success` 为 `false`；`request_id` 不相等。没有失败样本之前，**不根据任何响应判 `not_sent`**；点击后能判 `not_sent` 的情形本阶段为零。
- 点击后可以读一次星标状态，作为 `page_observed`（`marked` / `unchanged` / `unknown`），只用于显示，不参与判定。

**记录与隐私**
- 判据只在内存里比较，本地日志和回执只记结论与原因分类。不记 `uid`、`request_id`、输入坐标或响应原文。

### 测试要求（实现阶段）

至少覆盖：能力协商四种组合 × 两个能力；未确认能力时的字段与 action；字段校验（必填、类型、上限、重复、未知字段）；后台无需预采集名单即可生成按账号转接，执行时账号零项/多项/包含关系/备注命中不得点击；策略版本变化后 claim 409；`allow=false` 遇收藏拒绝报 not_sent 且不取消收藏；`allow=true` 时取消收藏或再次转移任一步 unknown 即停止；标星状态取不到/过期/歧义时上报 `marked=null`、不生成 mark 且正常回复照常；转接在执行时核对状态，未知时不点击；回执聚合表每一行（含“收藏已取消但转移失败”）与 mark 单步骤三种状态、未开始步骤省略；mark/transfer 的 sent 不带 platform_message_id 可被接受、带了返回 400；`reply_deadline_exceeded` 终结事件不生成 mark/transfer、不能 claim；模型超时兜底不重置预算；孤立页面观察不得报 sent，转接完整完成判据通过才报 sent；点击前切换会话、浮层不属于星标、目标行重排均不点击；临时空列表不算离开。标星另需覆盖：已收藏或 `marked=null` 不生成、不 claim；请求核对的放行与拦截（目标不符、颜色不符、第二条 mark、unmark、页面代次变化）；成功判据各字段的缺失、类型不符、`false`、`request_id` 不等、超时、加载失败、无请求均为 unknown；响应按 CDP `requestId` 配对，乱序到达也不串；窗口外店主的手动操作不受拦截。来源绑定另需覆盖：旧请求是窗口内唯一请求、本次点击零请求（unknown）；四项与成功判据全部满足时仍为 unknown（`mark_binding_unproven`），不报 sent；同买家同颜色的人工或旧请求先于本次点击的请求到达（窗口内两条 → unknown）、点击前核对期间页面发出此类请求或点击前 3 秒内有此类请求（不点击）、核对期间或窗口内出现不能配对的输入（点击前不点击、点击后 unknown）、放行后页面重建、读取响应期间页面重建、放行后登录失效或换店（均 unknown，迟到回调不改写结论）。

### 管理配置与后台处理（1.3 补充）

管理设置接口仍是 `PUT /api/v1/admin/shops/{shop_id}/settings`。新增可选 `fallback`，只允许 `unhandled`（判断无法处理）、`error`（模型/内部判断报错）、`model_timeout`（最后实际尝试的模型槽超时且事件预算尚未耗尽）三键；缺省保持旧行为。每项使用下列四种互斥策略之一：

```json
{"action":"none"}
{"action":"handoff"}
{"action":"mark","color":"orange"}
{"action":"transfer","account":"主账号","allow_unmark":false}
```

- 策略只接受对应示例字段。颜色仅四色字符串，不接受平台数值；`account` 为转移会话对话框第一列“账号名”（首尾去空白后 1–40 字），由后台原样下发，前台执行时与转接弹窗第一列完整账号名完全相等匹配，不按昵称、备注或包含关系匹配。`allow_unmark` 只能布尔，缺省false；管理页可明确勾选“已收藏时，取消收藏并转人工”。保存不自动改动既有策略；旧客户端收到true仍放弃，新客户端按文末扩展边界执行。
- 每条规则可用 `handling` 携带同一策略，代替原 `reply` / `send`，二者不得混用；旧文字/商品内容规则保持原约定。混合方式的模型只能选择提供的规则ID，由后台根据已保存策略解析动作；不得由模型自由产生颜色、接收人或新动作。
- `unhandled` 仅覆盖无规则匹配或合法模型handoff；`error` 不覆盖租约、权限、会话归属等安全拒绝；历史缺失本身不是错误，不触发 error 兜底。总预算耗尽的 `reply_deadline_exceeded` 永不变为新动作，策略不刷新预算或有效期。
- 保存策略增加既有店铺设置版本，设置/策略变更使旧未领取决定失效。动作领取照常核对租约、能力、同一上下文、最新事件、设置版本及总截止；已领取重查不延长许可。
- 标星 `conv_state` 绑定本事件归属并从当前唯一会话重读，不跨事件复用旧状态。按账号转接不再上传或缓存接收人名单；执行时才读当前店铺、页面、买家与唯一账号行，页面代次、登录店铺或会话变化即停止，不复用旧页面读数。事件既有身份、`instance_id` / `session_id` / `generation` / `conversation_id` / `context_revision` 继续承载授权归属。收藏状态、接收账号及平台列表不交给模型。
- 原准备阶段的能力清单为空；本次明确启用按文末首次启用边界和前后台代码、安全复验实施。保存配置本身不打开能力，也不能绕过仅观察设置。成功语义与正向请求归属尚未证实，动作尝试后保持unknown；未经独立取证和审查不得报sent。

## unknown 人工核查（1.0 补充）

unknown 表示前台无法确认平台是否发出。管理员可到平台聊天记录人工核对后记录结论（仅追加记录）：

`POST /api/v1/admin/events/{event_id}/verify?shop_id=demo-shop`（管理员会话）
```json
{"outcome":"not_sent","note":"平台聊天记录中未见该回复"}
```

- 事件主键是（shop_id, event_id），event_id 不保证跨店唯一。管理界面必须传 `shop_id`；不传时仅在全库唯一匹配时执行，跨店同名返回 409 `ambiguous_event` 且不修改任何记录。成功返回更新后的事件快照；核查的管理员账号仅服务端审计保存，不在快照中返回。
- 仅当该事件 `delivery.status=unknown` 且尚未核查时可用；否则 409。outcome 只能 `sent` / `not_sent`；note 必填，1–200 字，只写核查依据，不写买家原文。
- 核查不改写 unknown：`delivery.status` 保持 `unknown`，事件快照新增 `delivery.verification={"outcome":"not_sent","note":"...","verified_at":1790000000}`（未核查为 null）。核查后不可再改；后台记录核查的管理员账号。
- 核查只是审计记录，不是同对话后续回复的前提（unknown 本来就不冻结对话）；被核查的旧事件仍**永不重发**，也不能再次 claim。
- 前台本地保留 unknown 记录、不删除；本地同样只禁止该条事件再次发送，不阻挡同一买家的新消息，也无需轮询核查结果。
- outcome=`sent` 只表示管理员核实平台已发出，不补 platform_message_id，也不等于业务问题已解决。

## 管理 API（仅管理员）

- `GET /api/v1/admin/summary`：`{"counts":{"pending":0,"processing":0,"ready":0,"sent":0,"unknown":0},"protocol_version":"1.0"}`。
  - 后台本地维护可增量返回 `maintenance`：`{"model_failures":{"<shop_id>":3},"worker_alive":true,"backup":{"status":"idle","last_success":null}}`。仅管理员可读；未登录、客户端令牌和首次密码未更换的管理员不得读取。客户端事件 / claim / receipt 及协议版本不变，旧后台可不返回该字段。
  - `model_failures` 是按配置店铺隔离的本进程连续模型失败次数（达到 3 次提醒），不是平台发送失败次数；规则直接命中、取消和过期不证明模型恢复。模型判断明确成功才清除对应店铺计数，进程重启从零计数；策略 fallback 不抹去原模型失败。
  - `worker_alive` 仅表示判断线程是否存活，不证明模型、平台或真实业务健康。`backup.status` 为 `idle|ok|error`，`last_success` 为最近有效 SQLite 快照的 Unix 秒或 null；仅元数据，不返回路径、备份、原始异常或模型内容。
  - 管理页登录后本地轮询并提示：连接未确认、线程停止、模型连续失败、unknown 记录、备份失败。缺失 / 畸形计数或请求失败不视为健康；已有记录保持不确定或过期提示。页面关闭 / 未登录时不承诺通知，不调用外部服务。
  - 备份为本机后台 SQLite 的每日一致性快照，保留最近 7 份，POSIX 目录 0700 / 文件 0600；不包含独立认证库、密钥或客户端资料，不等于完整部署回退。仅在独立实现部署后生效；不授权恢复、重启或平台动作。
  - unknown 数量包括已经人工核查但仍保留原 unknown 状态的历史；提醒不改写、不清除、不重试这些记录。建议回复的展示也不赋予 claim / 发送权限，前台“仅观察”与“人工接管”的发送阻止保持。
- `GET /api/v1/admin/shops`：`{"shops":[{"shop_id":"demo-shop","name":"演示店铺","settings":{...},"lease":null或租约}],"templates":[话术模板...]}`。旧后台可不返回 `templates`。
- `POST /api/v1/admin/reply-templates`：将当前话术另存为独立模板，详见下文“共用话术模板”；不绑定店铺、不开启自动回复。
- `GET /api/v1/admin/events?shop_id=demo-shop&limit=50`：`{"events":[事件快照...]}`；limit 1–200，不传店铺查全部。
- `POST /api/v1/admin/prompt-draft`：根据管理员本次输入生成未应用的提示词草稿，详见下方“管理员提示词草稿”约定；不写入店铺设置。
- `PUT /api/v1/admin/shops/{shop_id}/settings`：完整替换下列设置，后台增加 version；修改后旧未发送决定失效。
```json
{"enabled":false,"mode":"rules","system_prompt":"仅根据所提供的店铺规则回答；无法确认则转人工。","rules":[{"id":"hours","contains":"营业时间","reply":"演示：营业时间请咨询人工客服。"}]}
```
混合模式示例：
```json
{"enabled":true,"mode":"hybrid","system_prompt":"仅根据所提供的店铺规则回答；无法确认则转人工。","rules":[{"id":"shipping","contains":"发货","description":"问什么时候发货、几天能到","reply":"演示：付款后48小时内发货。"}]}
```
settings 返回上述字段加 version。mode=rules/model/hybrid。规则可带可选 `description`（适用问题说明，如“问发货时间、几天到”；字符串，最多 500 字符；不传或空串表示无），只用于混合模式的语义匹配，不会发给买家。

### 共用话术模板（管理员增量）

模板只含 `mode/system_prompt/rules`，规则保持原有文字、发送条目及 handling 校验。店铺的 `enabled` 与 `fallback` 独立保存，不复制源店铺开关、账号凭据、模型配置或规格资料。

- 创建请求严格为 `{name,mode,system_prompt,rules}`；name 去除首尾空白后为 1–80 字，同名返回 409 `template_name_exists`，坏名称为 400 `invalid_template_name`，额外/缺失字段为 400 `invalid_template`，话术内容沿用现有校验及错误码。成功 HTTP 201 返回 `{template_id,name,version:1,mode,system_prompt,rules}`。template_id 为服务端生成的 32 位小写十六进制值。列表按名称与编号排序。保存模板本身不修改店铺设置。
- 管理设置 PUT 增加可选 `template_id/template_version`。非空 template_id 表示选用模板，必须提交其当前整数 template_version；有效但不存在的编号为 404 `template_not_found`，版本缺失/类型错误/过期为 409 `template_changed`。编号类型非法为 400 `invalid_template`。
- 显式 `template_id:null` 或空串表示本店独立配置，template_version 应不传或为 null；本次提交的有效话术保留，此后不跟随模板更新。未绑定时提交非空版本为 400 `invalid_template`。
- 选用模板时仍提交完整设置。若共享三字段有变化，在一次事务内更新模板版本，并将共享内容同步到全部已绑定店铺；各店 enabled/fallback 保持自身设置，来源店按本次提交保存自己的 enabled/fallback。每个受影响店铺的 settings.version 只增加一次，旧未发送决定按既有版本校验失效；无共享变动时模板与其他店铺版本不变。空 description 与省略等价，不产生无意义的模板版本变更。
- 返回设置中，已绑定店铺增加 `template_id/template_version`；独立店铺保持原有返回字段。客户端事件协议及引擎内部只使用原有效话术，不需要理解模板编号。
- 旧 PUT 未带 template_id 时，未绑定店铺按旧行为保存；已绑定店铺保留绑定，只允许共享内容与模板当前值相同的本店设置更新。若共享内容不同，409 `template_changed`，不隐式解绑或覆盖模板。所有校验及同步失败均不得部分提交。
- 旧管理页继续兼容现有话术编辑区，选用/取消选用先留在未保存状态，保存后生效；旧页“保存并同步模板”明确作用于共用店铺。切模板不改本店启用开关与兜底处理；有未保存话术时先确认替换。后台轮询和迟到响应不得覆盖当前编辑，旧模板版本不得覆盖他店新改动。模板名称以文本展示。新版独立编辑页见下节。
- 上述管理端点沿用管理员登录、首次密码更换与权限校验，不允许客户端令牌读取或写入。模板在现有本机 SQLite 持久保存，不新增服务、运行依赖或定时任务。

#### 独立话术模版编辑页

- 管理页分为“店铺配置”和“话术模版”。店铺页选择模版、保存本店开关和 `fallback`，并保留本店商品学习。判断方式、提示词和规则在模版页维护，可新建、保存、另存；内容按分区折叠。未绑定店铺的原有效话术继续保留，可打开到模版页另存，不自动创建绑定、覆盖配置或启用店铺。商品知识仍按店铺隔离，不进入模版。
- 新增 `PUT /api/v1/admin/reply-templates/{template_id}`，沿用上述管理员与首次密码更换限制。编号须为32位小写十六进制，非法为400 `invalid_template`；合法但不存在为404 `template_not_found`。请求严格为 `{name,version,mode,system_prompt,rules}`，额外/缺失字段或非正整数版本（含布尔）为400 `invalid_template`。name及共享三字段沿用创建校验；同名（排除自身）为409 `template_name_exists`；过期版本为409 `template_changed`。
- 返回当前完整模版 `{template_id,name,version,mode,system_prompt,rules}`。名称或共享内容变化时模版版本增加一次；完全未变则不增版。仅名称变化不修改店铺设置；共享内容变化在同一事务内同步全部已绑定店铺，每店 settings.version 增加一次，本店开关、fallback、商品资料、模型及凭据均不变。失败不得部分提交。零店铺选用的模版也可独立保存。
- “另存模版”复用现有创建POST，以新名称保存当前编辑内容，不修改原模版或绑定任何店铺。店铺选择模版只提交其已保存内容和当前版本，不携带模版页另一份未保存的草稿；旧管理设置PUT兼容行为保持。异步保存、轮询和换店不得覆盖模版未保存编辑；旧版本响应不回退模版缓存；版本冲突保留草稿，明确要求重载后再改。

- **rules**：规则按列表顺序做不区分大小写的字符串包含匹配（只看最新买家文字消息）；未命中转人工。**规则模式的业务判断不调用模型**，即使后台已配置模型；管理员主动连接测试和草稿生成独立于业务判断方式。
- **model**：只用模型（主→备），仅使用后台私有配置的模型地址和密钥；主备均未配置或均不可用时转人工。
- **hybrid（语义匹配规则）**：
  1. 调用一次模型链（主→备），先依据店铺提示、最新买家意图与本次可见上下文判断处理方式，不再因最新文字含关键词就直接返回固定话术。店铺要求售后交人工时，应区分购买前的假设咨询与已购订单问题；需人工的情形返回 handoff，不以通用规则或“请联系人工”的普通回复替代。
  2. 同一次请求附上当前规则列表的 `id`、`contains`、`description`（不附规则 `reply` 原文，也不附其他店铺数据），由模型二选一：返回 `rule_id` 表示买家意思命中该规则，或按店铺提示返回正常的 reply/handoff 决定。图片/卡片及附件沿用原模型输入路径。
  3. 模型返回的 `rule_id` 必须是本次请求所附规则列表中的 id；可同时带 action/text/reason，但后台只按有效 rule_id 解析，忽略模型改写的规则内容。命中时后台生成以该规则 `reply` **原文**为回复内容的 reply 决定（模型不得改写），由前台按发送许可流程执行发送；reason 为 `rule_semantic:<id>`。
  4. `rule_id` 不在列表中时不得使用任何规则回复：若同一输出另含合法的 reply/handoff 决定，按该决定处理（reason 为模型来源）；否则视为模型输出无效，按主备策略换备用，均失败转人工。
  5. 模型生成的决定 reason 为 `model:<slot>:…`，与模型模式相同；主备均未配置或均不可用时转人工。
- 管理员提示词明确写“不要超过/不得超过/不超过/最多/至多 N 个字（或字符）”时，后台对模型自写 reply 的非空白字符数校验，标点、数字、字母均计入；多个明确上限取最小的 1–2000 整数。规则原文与 reason 不受此限制。超限视为本次模型输出不可用，只沿既有主→备链尝试备用一次，不重试主模型、不截断文字；合法 handoff 不触发备用。未写明确数字上限时保留原行为。
- 可见信息已经支持业务 handoff 时，`history_complete=false` 不再单独抑制已保存的兜底处理策略；平台动作仍要求本次能力、已核实的会话状态、唯一接收人、最新事件/设置/租约及预算全部通过。缺历史本身、权限变化、超时终态等不新增平台动作。
- 新店铺默认 disabled + rules。切换模式属于设置修改：后台增加 version，旧未发送决定失效。模式与规则是后台设置，客户端协议字段不变。

新店铺默认 disabled，开启只作用 Claw-Next，不代表其他自动回复工具已停止。

## 后台模型配置（仅管理员，不改变客户端协议）

- `GET /api/v1/admin/model` 返回 `version` 与 `primary`、`backup` 两套配置。每套只包含 `base_url`、`model`、`timeout_seconds`、`key_configured`；不会返回密钥或环境变量名。
- `PUT /api/v1/admin/model` 提交以下结构；成功返回公开配置与递增版本：

```json
{"version":0,"primary":{"base_url":"http://127.0.0.1:1234/v1","model":"your-local-model","timeout_seconds":20,"api_key":"","clear_key":false},"backup":{"base_url":"https://api.deepseek.com/v1","model":"your-deepseek-model","timeout_seconds":20,"api_key":"<private-key>","clear_key":false}}
```

- 主模型优先，连接失败、超时、HTTP 错误、不可用响应才尝试备用模型一次。有效的 `handoff` 决定不会触发备用；两套均不可用则转人工。每次新判断重新从主模型开始。决策 `reason` 标记实际模型槽位及切换原因，不改变客户端字段或发送流程。
- 云端地址要求 HTTPS；本地 `localhost`、回环或私有 IP 可用 HTTP。地址不得包含用户名、密码、查询参数或片段，不跟随重定向；服务端追加 `/chat/completions`。地址最多 2048 字符，模型名最多 128 字符，超时为 1–60 秒整数。每套地址和模型同时为空表示停用该套。
- `api_key` 留空或省略保留已有密钥，`clear_key:true` 明确清除；不能同时清除并提交非空密钥。本地无密钥服务可直接调用。密钥保存在后台私有数据目录的数据库中，禁止提交 Git、公开分享或把数据目录当作静态文件目录。
- 旧单模型配置自动映射为主模型，旧格式 PUT 仍可更新主模型。原有主模型环境变量密钥兼容；明确清除密钥或更换主模型地址后，不再自动套用旧环境密钥。旧 `version` 保存返回 409 `model_config_changed`。保存使旧判断不能领取新发送许可；`unknown` 不变。
- `POST /api/v1/admin/model/test` 提交 `{"slot":"primary","version":1}`（或 `backup`），对该版本已保存配置实际请求一次无业务内容的 completion，不调用备用、不创建业务事件。返回 `{"slot":"primary","version":1,"ok":true,"reason":"ok","latency_ms":123}`；失败仅返回安全错误类别，不返回模型原文。未登录拒绝，旧版本返回 409。请求期间配置变化则结果标为过期。测试通过表示该配置能够返回 completion，不等于真实客服效果验收。
- 管理页先保存再测试；编辑、保存、退出后旧测试结果作废。配置保存并不执行模型请求；主动连接测试、主动提示词草稿生成、模型模式中的新业务判断、混合模式中未被规则直接命中的新业务判断会调用服务。规则模式的业务判断不调用模型；提示词草稿与补充合并只使用主模型，聊天规则的分批草稿按后文规定每批最多尝试一次备用模型，不改变业务判断策略。
- 管理页每 5 秒刷新店铺心跳，仅表示客户端已连接后台。有效租约不等于平台已登录；本协议尚无平台登录验证状态上报字段。

### 管理员提示词草稿

此接口是新增管理能力，是否可用以部署版本为准；旧后台可返回 404，调用方不得因此尝试客户端业务接口或自动开启回复。客户端身份、心跳、事件、租约、claim、回执和协议版本 1.0 不变。

`POST /api/v1/admin/prompt-draft`，已完成首次改密的管理员 Bearer，JSON 只允许下列三个字段：

```json
{"shop_id":"demo-shop","brief":"虚构示例：材质未确认时先询问款式或转人工。安装和退换条件待确认，不承诺。","version":1}
```

- `shop_id` 必须满足通用 ID 格式并已登记；此字段只用于检查目标店铺和绑定草稿，不读取该店铺已有提示词、规则、聊天或商品资料作为生成内容。
- `brief` 为字符串，去掉首尾空白后长度为 1–4000 个字符。仅发送该内容及后台固定的整理要求给已保存的主模型；输入属于待整理资料，不授予执行操作的权限。管理员不应输入密钥或买家私人信息。
- `version` 为非负整数（布尔不算整数），必须等于 `GET /api/v1/admin/model` 的配置版本，**不是店铺设置版本**。请求不能指定模型、地址、密钥或备用策略。
- 每次主动请求只调用主模型一次；未配置、失败、响应格式错误或截断时不尝试备用模型。单次网络等待上限 45 秒，只用于此次生成，不修改已保存的回复超时或模型配置；它不承诺从点击到完成的总耗时一定小于 45 秒。
- 全后台最多同时执行一份草稿生成；繁忙直接拒绝，不排队。退出登录、修改密码和配置操作不会等待该模型请求结束。关闭页面或切换店铺只丢弃旧结果，不保证立即取消正在进行的模型调用。

成功 200：

```json
{"shop_id":"demo-shop","version":1,"draft":"材质待确认时先询问款式或转人工。安装与退换条件未确认，不作承诺。"}
```

`draft` 为去掉首尾空白后的 1–8000 字符纯文本；模型返回截断标记时不交付部分草稿。输出仍是未核实的模型内容，不保证业务事实正确。管理页只作为可编辑文字展示，禁止按 HTML 执行；必须由管理员明确确认替换提示词，再通过原设置接口保存，才应用到该店铺。生成与替换都不自动保存、不改店铺开关、判断方式、规则或模型配置，不创建事件、发送许可或回执，不发送消息。店铺处于关闭或规则方式时也可主动生成草稿，但不会因此启用模型业务判断。

错误沿用统一错误对象：

| 情形 | HTTP / code | 行为 |
|---|---|---|
| 未登录、会话过期或生成期间会话被撤销 | 401 `unauthorized` | 不返回草稿；首次校验失败不调用模型 |
| 客户端身份 / 管理员仍需首次改密 | 403 `admin_required` / `admin_password_change_required` | 调用模型前拒绝 |
| 字段集合或版本类型错误 / brief 错误 / ID 错误 | 400 `invalid_prompt_draft` / `invalid_prompt_brief` / `invalid_shop_id` | 不调用模型 |
| 店铺未登记 | 404 `shop_not_found` | 不调用模型 |
| 模型版本不匹配，或生成期间模型配置改变 | 409 `model_config_changed` | 首次校验失败不调用模型；晚到结果丢弃 |
| 已有草稿生成正在执行 | 429 `prompt_draft_busy` | 不创建第二个模型调用 |
| 主模型未配置、请求失败、输出为空/过长/格式错误/截断 | 502 `prompt_draft_unavailable` | 不回显上游正文或凭据，不调用备用，不写设置 |

返回草稿前再次检查管理员会话和模型版本；任何失败都释放并发名额。界面必须绑定发起时的会话、店铺和请求序号，切换店铺、退出或重置后不能应用旧结果。相同请求再次提交是新的模型调用，可能产生费用；失败不得自动重试。验收至少覆盖权限、首次改密、输入边界、仅主模型、无设置/事件写入、并发拒绝、生成中退出/改模型版本和跨店旧结果丢弃。

## 非本版本能力

前台已有拼多多平台适配：每店独立平台工作台登录、店铺身份交叉核验、被动读取平台页面自身加载的会话与订单数据、经核验的单次点击发送，多店各自隔离、可在界面切换。收藏标星与转人工按“会话操作（1.3）”和文末首次启用边界执行，审查通过且能力协商确认前不生效；handoff 始终只是建议。以下仍不在本版本内：订单/售后的主动实时查询（只有前台从页面被动读取、随上下文附带的只读订单摘要）、备注/库存写入、云端托管资源。管理界面仅管理本项目。

实现、测试通过、进程启动、平台确认与真实业务验收是不同证据。正式接管店铺前须逐店完成线上验收；不能凭模拟或虚构数据测试宣称已完成实盘迁移。

## 契约 A：事件预算、未领取事件取消与响应计时

状态：**前后台已实现，按心跳能力协商启用**。`protocol_version` 仍为 `1.0`。客户端在心跳中声明 `reply_deadline`，后台确认后，客户端才为新事件提交预算或调用取消接口。代码实现不等于测试通过、部署完成或真实业务验收；这些状态应分别核对。旧客户端、未确认能力或缺省预算的事件保持既有行为；预算与取消相关的扩展情形按本节规定处理。`send_item` 保持独立协商，原发送许可、回执与 unknown 保护不变。

示例全部为虚构数据。

### A.1. 范围与不变量

本扩展只增加可协商的事件预算、未领取事件取消和响应计时；不包含 SSE、客户端状态上报、模型主备预算比例或忙时溢出策略。

- 首次观察后 20 秒限制的是**开始平台发送**；已开始的发送继续按现有许可和回执规则结束。
- 前台用本地单调时钟执行最后拒发检查；重启按持久记录恢复。后台无法补偿网络传输，也不能替代该检查。
- `decision.expires_at` 的 60 秒回复有效期、`claim_expires_at` 的 10 秒许可及本扩展预算保持不同含义。
- `unknown` 永久保留、不重试、不改写；未领取事件不制造 attempt 或回执；放弃仅作用于本事件，不增加买家锁。
- Bearer、店铺隔离、原客户端归属、最新消息、版本、设置与租约检查继续有效。`send_item` 仍单独协商。

### A.2. 能力协商

沿用现行心跳 `capabilities` 的校验与交集规则，新增独立能力名 `reply_deadline`，不与 `send_item` 绑定。

客户端只有在最近一次成功心跳确认本 instance/session/generation 的该能力后，才在新事件中发送预算或调用取消接口。租约变化必须重新确认；无能力字段视为未确认。旧后台不返回此能力时，新客户端只执行本地时效，不试探性发送新字段。租约已失效时不提交新事件，也不通过去掉预算字段降级绕过租约。

未经确认首次提交预算返回 400 `capability_not_confirmed`；未经确认首次取消返回 409 同名代码。对原客户端已有事件，先核对请求摘要：原样重投仍返回原记录，不重新判断能力/租约；不同请求体仍为 `event_conflict`。未曾受理的请求须满足当前能力/租约，前台不可换 event_id 或去掉预算来规避。撤回能力只阻止新的首次扩展请求，**不得延长已经受理的预算、复活已终止事件或改变已领取尝试**。已成功取消的重试按下文幂等规则处理。

两处同名能力错误使用不同 HTTP 状态码是有意约定：首次提交的新字段校验使用 400，取消操作的状态条件冲突使用 409；前台均按确定结论处理，不重试。若能力在请求体冻结后、首次受理前撤回，前台保留原请求体，收到 400 后将该事件记为被拒、消息显示“本条待人工”，不换 event_id、不删预算重投，也不锁住整个买家。

### A.3. 提交预算（可选）

`POST /api/v1/events` 顶层增加 `remaining_budget_ms`：整数，范围 0–20000。布尔、浮点、字符串、null、非有限值及越界均为 400 `invalid_remaining_budget`；未创建事件。字段缺省保持旧行为，不强加后台 20 秒截止。

- 前台准备完成后、首次持久化待提交请求体前，用单调时钟计算剩余毫秒，向下取整并限制在 0–20000，再固定原请求体；之后重投不重新计算。同 event_id、同请求体仍幂等；改变预算属于 `event_conflict`，不能刷新截止。
- 后台首次受理时以本机单调时钟建立截止，覆盖排队、主备调用、解析及就绪等待。模型调用只分得尚存预算，不把各槽 timeout 简单相加。
- 预算冻结到后台首次受理之间的传输或重投耗时不会从冻结值再次扣除，因此后台截止可能晚于前台本地截止；这是保持原体幂等的明确取舍。前台本地过期后停止重投，并继续在申请许可前、许可返回后、点击前拒绝过期发送，不能据此延长本地 20 秒。
- 向下取整后为 0 也按以下规则处理，不先尝试一次模型。0 合法：在受理事务内直接持久化终态，202 返回 `state=ready`、`decision={action:handoff,text:"",reason:reply_deadline_exceeded,expires_at:受理墙钟秒}`、`delivery.status=unclaimed`、`attempt_id=null`；不进入 pending、不启动模型。
- 预算不可通过轮询、续租、重投、设置更新、取消或 claim 延长。字段缺省的旧式事件仍遵守原契约。

### A.4. 截止的响应与执行

预算事件的快照可增加 `event_deadline`，类型为有限 Unix 秒数字：`accepted_wall_s + remaining_budget_ms / 1000`，用于诊断及重启恢复。旧式事件省略此字段。它不是客户端或平台的发送许可；前台不按服务器墙钟替换本地单调截止。

可发送 ready 指 `state=ready`、`decision.action` 为 reply/send_item、delivery=unclaimed 且无 attempt；handoff/none 不属于该集合。后台在出队、调用模型前、主备切换、结果提交和 claim 事务内核对预算。到期且尚无 attempt 的 pending/processing/可发送 ready 事件原子结束为 `ready + handoff`、`reason=reply_deadline_exceeded`，文本为空，delivery 保持 unclaimed。归属以事件首次受理的持久记录为准，并与本次请求身份比较；请求字段不能覆盖原归属。所有因截止终止的事件（含初始预算为 0）都不能 claim；校验原归属及既有 attempt 后，对此终态返回 409 `reply_deadline_exceeded`。其他首次 claim 保留租约/版本等核验，并在 decision 有效期前检查事件预算；已领取 attempt 的重复 claim 查询保持原规则，不重新判断本扩展预算、不延长许可。

终止后记录不可再被模型晚返回、重启重判或设置变化覆盖。若其他终止原因已先提交（如 superseded），不改写该原因。无需仅靠客户端及时发 cancel 才停止无用判断；实现须有有界的超时处理，不无限开线程。

前台收到 `ready + handoff` 且 `reason=reply_deadline_exceeded`，或 claim 返回 409 `reply_deadline_exceeded` 时，显示“本条待人工”，不重试该条、不增加买家接管锁；同一买家后续新消息照常处理。

**若 claim 已先成功**，后台截止不改变该 attempt，也不阻止按原许可提交回执。前台仍检查自己的发送开始截止：确定未开始则用已有 attempt 上报 not_sent；已开始则不因本预算到期中断，但仍受原有 claim 许可、平台确认等待与回执规则约束；超时仍 unknown，绝不重发。

### A.5. 取消未领取事件

`POST /api/v1/events/{event_id}/cancel`，客户端 Bearer，JSON：

```json
{"instance_id":"instance-001","session_id":"session-001","generation":1,"reason":"reply_deadline_exceeded"}
```

取消重试必须保留原请求的四字段值，不追加诊断字段或改写归属。请求只接受以上四字段；reason 为固定枚举 `reply_deadline_exceeded`，不接收自由文本；格式错误返回 400。既有 token 的 shop/client 是权限来源，不能通过请求指定或切换。

校验顺序与结果：

1. 非原 shop/client：404，不泄露事件；instance/session/generation 必须匹配原事件，否则 409 `cancel_owner_mismatch`。
2. 同一归属已经因截止终止且仍无 attempt：200 返回当前终态，不改时间、不制造记录；此只读式幂等重试无需重新取得租约或能力。
3. 其他首次取消须已确认能力、当前有效租约，错误沿用心跳/claim 的租约代码。仅 pending、processing、可发送 ready 且 delivery=unclaimed、无 attempt 可取消；已 superseded 或其他终态返回 409 `cancel_not_allowed`。
4. 已 claimed、sent、not_sent、unknown 或任何已有 attempt：409 `cancel_not_allowed`，不得清除尝试或核查记录。首次取消依次核对归属、能力、租约、可取消状态。
5. 成功 200：原子结束为 `state=ready`、`decision={action:handoff,text:"",reason:reply_deadline_exceeded,expires_at:终止墙钟秒}`，delivery=unclaimed、attempt_id=null。不新增 delivery 状态，不伪造回执。后台内部保存不可复活的终止标记，快照沿用既有结构。

新 instance/session 不得首次取消旧归属事件；旧事件由后台截止或原 superseded 规则结束。已成功取消的请求若跨重启重试，必须保留原请求中的归属字段，只能读取同一终态，不能换成新身份申请取消。

**双方已确认的重启恢复规则：** 发出 cancel 前持久化的意图记录只证明曾计划发起，不能证明请求已到后台或取消已成功。重启后的新 instance 对这类记录先查询事件快照；只有确认同一事件已经因截止终止、无 attempt 时，才可按原四字段执行只读式幂等重试。未确认该终态、请求失败或仍为可取消状态时，不以旧意图记录发起 cancel，交由后台截止或原 superseded 规则处理。已 claimed 或 unknown 始终不取消、不重放。

前台本地超时且确认能力、仍有原租约、无 attempt 时，尽力调用 cancel；网络失败只允许原样有限重试，不延长本地截止、不伪造后台终态。无能力或无租约时只记本地放弃。后台预算到期不依赖 cancel 成功；取消可以用于符合以上条件的旧式事件；是否取消由前台本地截止决定，不以服务器墙钟证明客户端过期。它只能让已授权的原发送者放弃自己的事件，不能扩大发送权限。

### A.6. 竞态与重启

- cancel/到期处理先提交：后来的 claim 被拒绝，无 attempt。
- claim 先提交：cancel/到期处理不得改写 delivery；客户端按既有 not_sent/unknown 规则结束。事务内校验与写入不可分离。
- 模型完成提交必须再次核对事件可写状态、预算、设置、版本与原租约；失效结果丢弃。网络调用不持有数据库锁。
- 重启不持久复用进程内单调时钟值。预算事件原子保存首次受理墙钟、原预算、墙钟截止及最近的可信墙钟检查点；恢复时先验证记录一致性。
- 在本机墙钟可信的前提下，用截止减当前墙钟恢复剩余值，且不得超过原预算。缺失、非有限、相互矛盾或当前墙钟早于已保存检查点时，对尚未领取的预算事件保守按过期结束。
- 仅凭墙钟无法证明所有跨重启的校时历史；不得声称能检测任意幅度的回拨。若部署环境不能保证墙钟可信，预算事件恢复时直接保守过期。
- 现行重启规则优先保护发送：后台恢复未完成 claim 时归 unknown；已有 unknown、sent 等结果不变。前台只有持久日志证明未调用平台时才可按原规则报告 not_sent，后台已有 unknown 仍优先保留，不能被该回执覆盖。旧式事件不因缺少预算记录被误判过期；预算事件同身份重判也不刷新已存在的预算。

### A.7. 后台计时（仅响应）

事件查询及其他快照响应可增加 `timing` 对象；客户端不得提交同名请求字段；事件提交和新增 cancel 请求携带 timing 返回 400 `invalid_field`，不扩展既有 claim/receipt 的未知字段校验策略。未发生或无法测量的字段省略，不能编造为 0。实际测得 0 毫秒合法；所有耗时为有限非负整数，布尔不充当数字。

| 字段 | 含义 |
|---|---|
| queue_wait_ms | 受理至开始判断；开始后提供，不含模型调用 |
| decision_ms | 开始判断至判定完成，含主备调用与解析，不含排队 |
| primary_ms / backup_ms | 实际尝试对应槽的耗时，未尝试则省略 |
| model_slot | 成功产出判断的 primary 或 backup；规则或全失败省略 |
| fallback_used | 判断结束后给出布尔值，表示是否实际尝试备用，不限于成功 |
| failure_class | 最终失败的固定分类；成功省略 |

取消与自动到期竞态时，以先提交终态者确定 failure_class（cancelled 或 deadline_exceeded），之后不可改写。failure_class 固定为：`deadline_exceeded`、`cancelled`、`model_unavailable`、`model_invalid_output`、`internal_error`。取消/截止终态若判断尚未开始，不伪造 decision_ms。规则未命中是正常 handoff，不作为模型失败。模型晚返回不得更改已终止快照的计时。

不返回异常原文、地址、密钥、提示词、买家文本或模型回复。decision_ms 已包含 primary_ms/backup_ms，前台将其与自身等待后台时间分列，不相加重复计账；旧后台缺失时显示明细不可用。计时不参与发送授权。

`timing` 为可选诊断对象。已知字段的类型、数值或枚举不合法，或 timing 本身不是对象时，前台忽略整个 timing 并按明细不可用处理；不因此拒绝整个事件快照，不把不合法值记作 0。未知 timing 字段忽略以保留前向兼容。此宽容规则不适用于身份、归属、decision、delivery 等授权字段，它们仍须按现行契约严格校验。

### A.8. 兼容与验收矩阵

| 场景 | 必须验证 |
|---|---|
| 旧前台 / 旧后台 | 原契约行为不变 |
| 新前台 / 旧后台 | 能力未确认，不发送新字段或 cancel；本地拒发继续有效 |
| 旧前台 / 新后台 | 缺省预算保持原行为；未知响应字段不破坏解析 |
| 新前台 / 新后台 | 能力确认后才启用；撤回不复活已有预算事件 |
| 缺省、0、20000、20001、null、true、浮点预算 | 旧行为、立即终止、接受、其余 400；失败不落事件 |
| 重投相同/不同预算 | 原样返回原事件 / event_conflict，截止不刷新 |
| 冻结后首次受理前撤回能力、提交重投耗时 | 400 确定拒绝且不改体绕过；后台截止可能较晚但前台本地截止不变 |
| 排队中/模型中/ready 未领取到期 | 无新模型调用或新 claim；晚结果不能覆盖终态 |
| cancel 与 claim 并发、取消与模型返回并发 | 恰有一种可发送结论，无 cancelled 与 attempt 混合状态 |
| 不同店铺、client、instance、session、generation | 隔离、拒绝且不改状态 |
| 取消重试、租约到期后重试、服务器自动到期后重试 | 匹配原归属的已终止结果幂等返回，不续期 |
| 重启时仅有 cancel 意图记录、原请求未发出或响应丢失 | 先查终态；未确认截止终态时不发起旧归属的首次取消 |
| 已领取但未开始 / 已开始 / 已 unknown | 原回执规则，不伪造未领取事件的 not_sent，不重放 unknown |
| 重启预算过期、记录损坏、可检测回拨、旧式事件 | 保守恢复；已有预算不刷新；无预算的旧式行为保留 |
| 主成功/备成功/全失败/规则/取消/重启计时 | 字段只在实际测得时出现，枚举与类型明确，无敏感原文 |
| timing 类型、耗时或枚举错误、未知字段 | 错误已知字段使整个 timing 被忽略，快照其他字段照常严格校验；未知字段忽略 |
| 同一买家旧事件取消后新消息 | 新事件正常处理，不被旧事件冻结 |

### A.9. 实施前验收

前台实施与验收须覆盖：独立能力名及撤回规则、未知响应字段兼容、固定预算的原样重投、取消幂等和错误码、仅响应计时、服务器截止不替代最后本地检查。

后台实施与验收须覆盖：到期与 claim/cancel 的原子性、ready 事件截止、旧式兼容、主备整体预算的可终止执行、重启恢复与模型晚返回隔离。具体模型并发数与主备分配继续由虚构/脱敏基准测试决定，本扩展不预设 99% 达标。


### 管理员聊天规则与提示词补充草稿

以下接口仅供已完成首次改密的管理员使用，不扩展客户端协议或发送权限。导入和生成均不写入店铺设置、聊天数据库、事件或发送队列。导入不调用模型。新管理页的规则分析每批先调用已保存的主模型，失败时仅尝试已配置的备用模型一次；旧同步规则草稿及补充合并提示词仍只调用主模型。每个模型单次网络等待上限 60 秒，不改变已保存的回复超时；整个文件的分析时长取决于批次数。所有接口与原提示词草稿共用一个并发名额。

**导入预览**：`POST /api/v1/admin/chat-import`，参数严格为 `{shop_id, filename, text}`。文件内容为 UTF-8 JSON/JSONL、CSV 问答列或明确“买家/客服”角色的 TXT。解码后 `text` 的 UTF-8 字节数必须为 1–10485760（10 MiB），超限返回 400 `invalid_chat_import`；这是导入文本限制，不是 HTTP 请求体限制。完整请求经过 JSON 转义、包含其他参数后另受 40 MiB 请求体上限约束，两项须同时满足。仅处理文本问答，不读取文件路径、链接、附件、图片或其他系统数据。姓名/用户标识等元数据不进入模型，常见联系方式自动过滤；过滤不能保证去除所有个人信息，管理员须核对预览和店铺。上传不等于已经发给模型。

旧同步接口保持 `{shop_id, shop_version, pairs, stats, warnings}`，每个 pair 为 `{id, question, answer, conversation}`，匿名本次导入编号。保留旧客户端最多 200 组、24000 字的均匀抽样兼容行为；新管理页使用以下完整导入接口，**不抽样、不因超过 20000 条消息拒绝有效文件**。

**完整分批导入**：管理页左侧提供独立“聊天记录整理”入口及店铺选择，不再占用话术配置的规则编辑区域。

- `POST /api/v1/admin/chat-import/jobs` 参数同同步导入，HTTP 请求体同为 40 MiB；返回 202 `{job_id, shop_id, shop_version}`。
- `GET /api/v1/admin/chat-import/jobs/{job_id}` 返回 `{job_id, shop_id, shop_version, status, phase, processed_messages, total_messages, processed_batches, total_batches}`。`status` 为 `running/completed/failed/cancelled`，`phase` 为 `parsing/extracting/completed`。解析阶段总量未知时两个 total 为 null；结构解析后按真实消息处理数更新，每批最多 1000 条。completed 另含 `result:{pairs, stats, warnings}`；failed/cancelled 另含固定分类 `error:{code}`，不回显原文。
- 全文件提取有效问答后，仅合并**脱敏后文字完全相同的 question 与 answer**，保留不同条件、标点和不同回答。每个 unique pair 为 `{id, question, answer, conversation, conversations, count}`；conversation 是首个匿名来源，conversations 是去重后的匿名来源会话列表，count 是该列表长度。同一来源会话重复出现不增加会话频次；不同来源会话的重复问答合并后仍保留频次。不得用模型伪造次数或把重复条目数当作会话数。
- stats 包含 `messages, parsed, eligible, selected, skipped, sampled_out, unique, duplicates`。selected=unique、sampled_out=0；duplicates=eligible−unique。未回答、媒体间隔、过长或含联系资料的问答仍整条跳过并提示，不能截断条件或答案后采用。单问最多 500 字、单答最多 1000 字。
- `DELETE` 同一任务地址取消任务并丢弃结果；已经发出的请求可能要等其结束，取消后不得再开始后续批次。工作实际退出前仍占用并发名额。清除、换店或退出不能仅停止显示而让旧分析继续发起新调用。
- 任务绑定发起时的**精确管理员会话**和店铺设置版本，其他管理员会话也不可读/取消。查询、取消均重新校验权限；未知、过期或其他会话任务统一 404 `chat_import_not_found`。店铺版本失效为 409 `shop_settings_changed` 并丢弃结果。任务及结果只留内存，终态最多保留 900 秒、最多 8 份；清除和取消移除问答结果，服务关闭清空任务。原文件不保存到磁盘。
- 页面显示真实文件读取进度和后台已整理/总消息数、批次。上传或解析总量未知时显示等待，不编造百分比。预览分页展示全部独立问答。换店、退出、重置、改文件后停止旧查询并取消已知旧任务；晚到创建回执也必须取消，不得显示或应用到新上下文。

**全量规则分析**：核对预览并明确同意后，`POST /api/v1/admin/rule-draft/jobs`，参数严格为 `{shop_id, version, shop_version, import_job_id, existing_rules}`。完整 JSON 请求体上限 4 MiB；existing_rules 按设置接口校验、用于比较的序列化文本最多 32000 字。import_job_id 必须是本会话、本店铺、同一设置版本下已完成的完整导入，不接受页面伪造问答或频次。返回 202 `{job_id, shop_id, shop_version, version}`。

`GET /api/v1/admin/rule-draft/jobs/{job_id}` 返回相同任务基本字段及模型 version、`phase:analyzing/completed`、`processed_pairs,total_pairs,processed_batches,total_batches,failed_batches`。completed 的 result 为 `{candidates,warnings}`。`DELETE` 同一路径取消；权限、归属、过期、并发和内存规则同导入任务。模型版本改变为 409 `model_config_changed`；保存模型也可能推进店铺版本，此时可先返回 `shop_settings_changed`。每次开始主模型或备用调用前及批次间核对原会话、店铺和模型版本，失效后不得再开始下一调用；已经发出的调用不声称可撤回。

- 所有有效独立问答都进入自动分批计划，**30 组/24000 字是新分析的每批上限，不是全文件抽样上限**；按来源频次优先、原编号确定顺序，不静默截去文件后半部分。每批最多 30 个独立问答，每个问答最多归入一个主要主题，因而模型最多返回 30 个主题不会在本批丢掉第 31 个；禁止对大批输入先裁成局部前 30。不同批次进度累计真实处理数量；失败批次计入已处理进度但须单独显示，不能将其写成成功分析。
- 每批主模型连接失败、超时、不可用响应、整体格式不合格或输出截断时，若有已保存备用配置，最多调用备用一次，两个槽位均不重试，采用相同来源与字段核验。合法空结果或部分候选被整条剔除不触发备用。某批两者都失败则明确记录未覆盖，继续其余批次；全部批次失败为 `assist_unavailable`。部分结果须在 warnings 明确失败批次数及“非全文件完整排名”，备用使用也明确提示。
- 模型内部来源使用连续匿名编号，返回前恢复到本次导入的原编号；来源必须存在，禁止同一批跨主题复用。每个返回 candidate 为 `{contains,description,reply,evidence_ids,count,conflicts,warnings}`。count 由其合法来源问答对应的**原文件不同来源会话集合的并集**计算，绝不累加重复会话或采信模型提供的次数。
- 批内允许单来源主题供后续跨批合并；各批通过核验的主题按去首尾空白并忽略大小写的相同 contains 合并，汇总来源及冲突。不同回复不能当成一致政策，保留来源最多的一份草稿并提示不同表述供核对。全部批次完成后，筛出至少两个独立来源会话的主题，按会话数降序最多返回 **30 条高频问题**；同频保持原处理顺序，不凑满 30 条。
- 缺失、重复、非法或复用来源、未知冲突编号、关键词重复、字段不合格时整条剔除并提示，不得修剪错误引用后继续采用该条；坏候选不消耗其他候选的来源。整体坏输出拒绝该模型整批结果。跨批警告较多时仅保留前面的核对提示并说明省略，问答来源不因此删减。语义归类可能遗漏或错分，完整分批提交不等于真实业务事实已验收；仍需逐条核对预览。

旧 `POST /api/v1/admin/rule-draft` 保持 `{shop_id,version,shop_version,pairs,existing_rules}`、最多 200 组/24000 字、仅主模型一次及 `{shop_id,version,shop_version,candidates,warnings}` 同步兼容行为；客户端不因此获得新能力。初始密码、退出及改密规则与其他管理接口相同。

历史车型结论不能推广成通用适配承诺；候选仍须提示核对具体车型、年份、版本、安装位置和商品资料。不支持的备注、转接、收藏标星等代操作承诺改为保守核对/人工处理话术，并明确 warnings；此保护不证明语义或业务事实正确，不增加平台写入能力。

conflicts 为可能冲突的现有规则 ID，不能保证发现所有语义冲突。界面显示来源问答及新旧规则，默认跳过或保留旧内容。管理员编辑并明确选择新增或替换；替换保留原 ID，移除旧发送或处理方式前明确提示。多项同时替换同一目标、超过 100 条规则或输入不合法时不应用。应用只填表并导航到“话术配置”，仍须独立点击“保存设置”，不自动启用店铺。规则分页每页 10 条，不丢编辑、不改变匹配顺序。

**补充合并提示词**：`POST /api/v1/admin/prompt-merge`，参数严格为 `{shop_id, version, shop_version, current_prompt, supplement}`。current_prompt 是页面当前文本（包括尚未保存的编辑），1–8000 字；supplement 为 1–4000 字。用户应看到会把这两段文字交给主模型的说明。

返回 `{shop_id, version, shop_version, draft, changes, conflicts}`。draft 为 1–8000 字，changes/conflicts 各最多 20 条纯文本，每条最多 500 字。模型被要求保留原有事实和限制，将明确补充按主题合并；矛盾要求只列入待核对点，合并草稿默认保留旧要求，管理员可在预览中编辑决定。输出仍可能遗漏或误解，页面须并排显示原文与合并稿；存在冲突时须人工核对确认，才能填回提示词框。填回不自动保存。

通用失败：无权限/初始密码未改为 401/403；输入不符为 400；店铺不存在 404；`shop_settings_changed` 或 `model_config_changed` 为 409；并发占用 `prompt_draft_busy` 为 429；同步模型接口无完整合格输出 `assist_unavailable` 为 502；异步任务执行失败通过查询中的 `status:failed` 与固定 `error.code` 表达，HTTP 200 仅代表查询成功，不代表分析成功。异步规则上下文不符为 `invalid_rule_context`，不得误报为文件导入失败。错误不返回上传正文、模型原始响应或凭据。生成中退出、换店、重置、输入改动及版本变化后旧结果不得填回，也不得再次应用已处理的同一批草稿。

## 本店产品学习与匹配（可选 `product_knowledge`）

用于个人本机使用：管理员在“话术配置”点击“学习本店商品”，客户端复用该店现有登录页，读取本店**在售**商品标题、属性和规格组合，后台按已配置模型分类并保存原文。无需新的浏览器、服务、密钥或逐店配置。只有当前店客户端已连接、平台身份与配置店铺一致时才能读取。不得导航走当前聊天、导出 Cookie、读取买家资料、操作购物车/订单或发送消息。

### 商品身份与回复上下文

- 心跳声明并确认 `product_knowledge` 后，`context.goods[]` 及 `context.messages[].card` 可增加 `product_key`：64 位小写十六进制不透明引用。card 仅 `goods`/`source` 类型可有该字段；goods_card evidence 引用的卡片必须具有相同 key。未确认能力不提交这些字段；旧客户端/后台保持原行为。
- 客户端以 `SHA256(JSON.stringify([shop_id,"product",canonical_goods_id]))` 生成；goods_id 仅接受正安全整数或 1–32 位非零十进制字符串，规范化为字符串。订单商品、商品卡片、来源卡片及采集结果使用同一算法。身份字段冲突、不合法或缺失时保留旧上下文，不推测 key。不同店铺的相同平台编号不共用知识。
- 原 `goods_ref` 继续是本会话的局部引用；产品知识按**本店 + product_key** 精确匹配，再附到本次 goods_ref。相同标题不当成同一商品；未匹配不借用其他商品资料。模板同步不携带产品知识。
- 模型只看到匹配到的原文事实、分类与本次 goods_ref；产品资料是数据，不是指令。属性否定、条件和整条规格组合不得被反转、拆混或推广；缺失信息要追问，不虚构材质、质保、实时价格/库存或车型适配。既有车型核验及发送门控保持。

### 管理端

- `POST /api/v1/admin/shops/{shop_id}/product-learning`，管理员会话、非初始密码；请求恰为 `{source_url:string}`。空值表示当前所选店铺。可接受 HTTPS 拼多多店铺/商品链接，商品链接必须有 goods_id；只提取 goods_id/mall_id 作为客户端选择条件，后台不请求该 URL，不支持任意网址。带 mall_id 时须与当前平台店铺相同；只有分享参数的链接不能独立证明店铺，界面明确实际读取的是当前所选店铺。返回 202 的状态对象。
- 新请求替代同店旧任务、清理旧暂存；不删除已发布知识，不改模型、话术、店铺启用或运行模式。
- `GET` 同一路径返回 `{status,processed,catalog_count,client_ready,products,...}`；存在任务时另含 request_id、total、details_incomplete、updated_at，结束时含 catalog_complete 或固定 error。status 为 `idle/queued/collecting/learning/completed/partial/failed`。processed 是已完成分类的件数，total 是平台列表报告数，未知为 null；均不表示真实业务验收。
- products 为最近 20 件的预览 `{title,category,facts,details_complete,link}`，facts 是捕获的原文，安全文本渲染；换店、退出或页面会话变化后不应用迟到响应。link 为空、`大链接（下单留言车型）` 或 `专车链接：<车名>`。
- 状态另含 notes（本店详情页要点）。`PUT /api/v1/admin/shops/{shop_id}/product-notes` 请求恰为 `{notes:string}`，最多 2000 字（去首尾空白后保存）、不得含 NUL，否则 400 `invalid_product_notes`；空值清除。保存后递增该店 settings.version，返回状态对象。要点作为数据随本店每次模型判断提供，用于回答材质、功能、透光等；要点没写的不得编造。

### 大链接与专车链接

- 后台按已学商品判断链接类型：规格组合含“留言车型/备注车型”的是大链接（表里有的车都可下单留言车型）；否则标题“…专用/专车专用/定制”前的车名（“/”分隔，裸型号沿用首个车名的品牌）或属性“适用车型”能在车型表查到的，是专车链接，其规格首项（如 `【26款】问界m7`）一并作为可做车型。其他商品不分类。
- 仅当买家最近的来源/商品卡片（goods_card 证据）是专车链接、车型查表为 matched/ambiguous、没有未完成订单，且该链接不含买家的车时，以 vehicle_other_link 替代 vehicle_fit：优先同车的专车链接（同品牌时须精确到车型），没有则大链接；句式固定为“您进来的是X专车链接，您的车需要拍「Y」专车链接/店里下单留言车型的通用链接，我给您记录车型”。目标链接在本会话可发送商品里时句尾加“需要链接说一声我发您”，买家下一条消息时以 vehicle_link_card 发该商品卡片（仍受发送能力门控，每事件一个动作）。不学、不报价格。

### 客户端只读任务与分批上传

- 已确认能力的当前租约心跳可收到 `product_learning:{request_id,selection:{goods_id?,mall_id?},expires_at}`。request_id 为 32 位小写十六进制，expires_at 为 Unix 秒。任务初始有效 1800 秒；绑定接收时的 client_id/instance_id/session_id/generation，同页操作还须核对原窗口/页面代次、登录及平台店铺。失效停止后续读取，未知上传不重新采集/重投。
- 只用当前 `https://mms.pinduoduo.com` 页面的原有请求方式：GET `/chats/userinfo/realtime` 核对身份；POST `/latitude/goods/queryGoods` `{pageNo,pageSize:20,status:1,goodsId?}` 分页；POST `/latitude/goods/goodsProperties`、`/latitude/goods/skuSelectorForMall` `{goodsId}` 获取文本属性和整组 SKU。这些仅是商品查询，不开放任意 URL/请求方法。每次页面读取有超时，失败不暴露响应或异常原文。
- 规格组合按首项分组为一行（如 `规格组合：款式："问界m5"；型号："前挡1片"、"尾挡1片"`），单行超 1000 字前拆行；形状不一的组保留整条组合。
- 按列表 total 继续分页，不以推荐商品列表代替整店。重复页、总数变化、空页未达总数或详情字段不全均明确不完整，不宣称全部已学。单品属性/规格失败可保留该品可读文本并标记不完整。当前只涵盖所读在售列表及文本，不包含纯图片详情、OCR、下架商品全量性或价格/库存实时性。
- `POST /api/v1/product-learning/{request_id}`：店铺客户端凭据；请求恰为 `{instance_id,session_id,generation,seq,products,total,finished,catalog_complete,error}`。seq 从 0 递增，严格整数；total 为 null 或 0–1000000 整数；finished/catalog_complete 为布尔。每个 product 恰为 `{product_key,title,facts,details_complete}`，title 1–200 字、facts 最多 80 条各 1–1000 字、details_complete 布尔，key 每次任务内唯一。最多 30 件且总请求仍受原 256 KiB 限制，客户端通常每批不超过 3 件/20000 字，不丢后续商品。
- 正常 error 为 null。取消读任务时 products 为空、error 固定为 `product_page_unavailable/product_source_changed/product_list_invalid/product_details_failed/product_upload_failed/product_collection_timeout` 之一。允许在原 owner 的分类处理中取消；晚到模型结果不得继续发布。后台模型失败固定 `product_learning_failed`。
- 每批分类使用配置的主模型，失败/输出不合格最多尝试已配置备用一次；不改已保存模型设置。输入商品编号临时匿名化，模型只输出分类（汽车用品/家居日用/数码电器/服饰鞋包/食品饮品/美妆个护/其他）与原事实下标；下标可为空，不触发备用。整批覆盖、下标/类型/范围核验通过后才恢复原 key 与原文；不保存模型编造的商品事实。
- 上传先检查租约/owner/序号/重复 key，模型调用不持数据库锁，提交前再核对原任务和当前租约。完全相同的最近一批 seq 与正文幂等返回，不能重复调用模型/更新知识；正文变化或乱序返回 409。取消不重试数据批次。
- 未结束的数据仅暂存。finished 后原子发布本次有效产品；失败不覆盖旧知识；本次未读到的既有产品保留，不能由部分列表认定下架或删除。发布有产品时仅递增该店 settings.version 使旧未完成判断失效，原设置/模板/开关内容不变。列表计数相符、catalog_complete 且所有文本详情完整才是 completed，否则 partial。恢复或任务失效不复用旧发送授权。

验收至少覆盖：多页不漏、重复页/空页、店铺与页面变化、否定及独立 SKU 组合、模型主失败备一次/空下标、数据上传结果不明不重试、旧客户端、跨店拒绝、暂存不提前生效、失败保留知识、精确商品引用及后台页面迟到响应。代码/虚构测试通过不代表已采到真实商品或模型回答真实业务正确。

### 收藏与转人工首次启用边界（2026-11-05）

- 能力仍按租约协商；旧客户端不声明则不执行。后台仅对已保存的结构化处理策略生成操作，提示词里的“转人工/收藏”文字不触发动作；未配置转人工策略时不确认该能力，普通回复不弹转移框。客户端观察/人工接管模式保持不执行。
- 收藏沿用现有未收藏限定、点击前核对和请求守护。真实适配器点击后一律 `unknown`，不重试、不改已有收藏颜色。
- 按账号转接增量（2026-11-07）替换提前采集：只在已授权的 transfer 执行时打开本店铺、当前会话的转接弹窗，按后台给出的完整账号精确定位；缺失、重复或页面/账号变化时不点击。没有接收人缓存或30秒观察记录，重启后旧事件仍不可执行。
- 配置中的“主账号”须核对为平台实际完整账号名并唯一匹配，不能按昵称、第一行或仅有一行猜测。未核对前不启用该店转移策略。
- 正式执行复用对话框、目标行、关联气泡的所有者核对；点击前重核租约、事件、买家、店铺、账号、页面和期限，最终坐标快照同时核对唯一买家。页面占用期间出现外来输入则停止。
- 目标账号确认点击后满足“转接完成判据”即回 sent，步骤为 `transfer:sent`，不带平台消息编号，界面显示转接成功并完结；只点行、未观察到完成或资格失效仍为 unknown。点击前确定放弃回 not_sent，省略步骤。所有终态均不重试、不重放历史消息。
- 已收藏会话的执行仍受冻结决定的 `allow_unmark` 限制。按账号转接在领取后读取当前收藏状态，未知则停止；已收藏且未勾选时不开始平台动作，报 not_sent，不取消收藏。不把一次事件组合为先转再标星或先标星再转。
- 身份和响应原值只在本机比较，公开回执仅写固定状态与计数；实现、虚构验证、发布与真实动作验收分开报告。

### 已收藏会话转接扩展（2026-11-05）

- 按账号转接增量（2026-11-07）改用决定中的 `transfer.account` 和独立能力 `transfer_by_account`，不提前读取目标。自动模式且非人工接管时，领取后才检查当前收藏状态并定位账号；未知状态不执行。既有10秒claim许可与原20秒消息预算不延长。
- 复用“转移会话→唯一账号行→关联的无原因直接转移”。开始前存在“转移失败”框则放弃。仅本次确认点击后新出现唯一“转移失败”框、包含已收藏说明和两个唯一固定按钮“取消收藏并转移”“暂不转移收藏会话”，才认定本次页面明确以收藏拒绝。单独HTTP200、列表消失或任意提示文字不替代此条件。
- `allow=true`才可继续点该框唯一的“取消收藏并转移”；最后一次页面读取同时核对唯一当前买家、拒绝框、固定按钮和坐标命中，随后同步重核页面、店铺登录、决定/许可有效期、租约/事件及截止，不再穿插异步扫描。外来输入或曾观察到页面/登录失效后即停止，恢复也不补点。任一归属或结构不能核实均unknown且不继续。
- 该按钮由平台一次性取消收藏并转移，前台不自行拼请求或另点一次转移。按下命令前持久化`unmark_and_transfer`尝试；同步异常、拒绝或超时不补点、不恢复收藏。第二步只有在组合按钮已派发且随后满足“转接完成判据”时才报 `sent/unmarked=true`；其余为 `unknown/unmarked=null`，不凭孤立星标变化推断完成。
- 后续按钮确已开始时，回执沿用两步骤：本次页面明确收藏拒绝为`transfer:not_sent/blocked_by_mark`，后续按钮完成时为 `unmark_and_transfer:sent/unmarked=true`，整体 sent；未确认完成时为 `unknown/unmarked=null`，整体 unknown。按钮尚未开始则不虚构第二步，首步保守保留unknown。崩溃恢复保留步骤尝试并上报unknown，不重发；本次不改变既有部分完成回执的后台校验与聚合规则。
- 旧策略默认false、现有店铺模式、接收人和收藏颜色均不自动改动。客户端实际安装/重启及真实平台动作仍按各自直接授权，虚构验证不等于实店验收。
