# 高地应急供水的发车、分罐与村点收水采集

夜班应急供水班组使用放行单、换罐台记录、村点小票和补车台回执。 这些上游资料可通过本地合成接口查阅。村点小票独立编号，发车与过罐台登记使用整数升。所有来源均使用班次指定时钟。

## 运行来源服务

使用 Node.js 22。运行 `npm ci --offline --ignore-scripts --no-audit` 校验锁文件，`npm run source` 启动服务。默认监听 `127.0.0.1:4173`，可用 `SOURCE_PORT` 更换端口。运行 `npm test` 检查来源发布内容、传输格式和本地门户交互。服务重启会清空临时门户请求。

## 来源协议

GET `/v1/{release}/{resource}` 读取资源。阶段名为 `opening`、`interim`、`confirmed`，分别是开始时、中间观察和后续发布。阶段名只用于选择模拟接口，使用资料中标注的编号与有效时间判断其业务含义。返回的 `X-Release` 指观察阶段。索引声明的页暂未发布时返回 404，服务暂不可用时返回 503。各发布方的业务编号及生效信息见资源正文。

时间属于班次 N33，从 21:00 到次日 05:00。litres 是整数升，同一计量证明允许最多 3 升计差，超出时转人工。放行单使用 dispatch，转罐需同一条记录双方签确认；无两签的量保留在发罐待查，不承认收罐的相关收水票。村端清单页面记录合起来构成该村本班资料。补车请求只有 accepted 才可改派，departed 已出车。portal 支持 request、reassign、inspect。
routes 是调度端提供的车次、当前罐和可能卸水村点关系，候选量受实际余量和班次约束。临时小票缺页也适用这张表，不能把同一段待核余量同时当作多村都已到货。

这些接口固定提供以下资源。分页资源名以各业务索引为准。

`targets`, `plant-index`, `dispatch-1`, `dispatch-2`, `transfer`, `villages`, `village1-1`, `village2-1`, `village2-2`, `village3-1`, `orders`, `routes`

POST `/v1/{release}/portal` 接受 JSON 对象，`action` 取操作名，`key` 是来件唯一请求号，`facts` 可携带操作的业务事实。首次接收通常返回 201，发出完全相同的报文按原请求返回 200，已有请求号换报文返回 409。用 `inspect` 和原 `key` 查询，可见回执时返回 200。无法查到记录返回 404。正常接收的回执含 `sourceRef`，业务状态字段随来源使用 `result`。合成门户保留请求并提供回执查询。

## 核对与补车工具

`water.mjs` 是零依赖 Node.js 22 CLI；采集结果、请求号、回执和改派轨迹保存在本地 `.water-state.json`（可用 `--state` 或 `WATER_STATE` 改路径），因此服务重启或后续班次发布后可继续收取，不会把一次 404/503 当成“没有资料”。

```bash
npm run source                 # 终端 A：启动合成来源
node water.mjs collect         # 终端 B：依次收取 opening/interim/confirmed
node water.mjs report          # 全村短缺、待查、转罐、守恒和派车状态
node water.mjs handover --village V2
node water.mjs trace D31
```

也可只收某个阶段或重复执行：

```bash
node water.mjs collect --release opening
node water.mjs collect --release interim     # village2-2 为 503，仍保留 opening 版本
node water.mjs collect --release confirmed
node water.mjs report --as-of interim --json
```

工具按 `班次/村点/村内流水号` 识别小票，所以 V1 与 V2 都有 `17` 号也不会互相覆盖。转罐仅在 `from_signed && to_signed`、不形成有向环且不超过当时罐内有效余量时移动归属；无双签的 X2 保留为未对上转罐段，T10 小票 `19` 标为待查而不是承认。放行量只用于罐/车次守恒，不会被当成村点收货，也不会因转罐或重开票重复计数。同一计量凭证的修订差不超过 3L 视为契约内；超差会在 `issues[].affectedBranches` 中圈定 dispatch、罐、转罐段、小票和村点。

### 本班 N33 的核对结果

| 村点 | 目标 | 可确认已收 | 待查覆盖 | 确实短缺 | 既有补车单 | 调度动作 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
| V1 | 750L | 600L | 0L | 150L | D32 250L，departed | 迟到 100L 小票使其超额 100L；已出车，交值班员，不能改派 |
| V2 | 750L | 530L | 20L（X1/T9 未对上余量） | 200L | D31 350L，accepted | 相对已确认缺口确定多 130L；未出车，可改派 |
| V3 | 400L | 327L | 50L（T10/19 号票受 X2 双签牵连） | 23L | 无 | 可新申请 23L，或从 D31 的确定余量中改派 23L |

W1 放行 1200L：已承认村收 1130L、罐内归属余量 70L（T8=50、T9=20）。W2 放行 500L：已承认村收 327L、归属余量 173L；另列 X2 未双签 200L 和 T7 物理计量超差分支，不与 T7 余量重复分配。interim 中出现的 X3（T9→T8, 25L）会形成 `T8→T9→T8` 环，工具拒绝其归属移动；confirmed 中该记录被修订撤回，历史和拒绝原因仍保留。

### 提交、重发与改派

所有写操作必须带稳定 `--key`。相同报文重发会取回原回执且只生效一次；同 key 改报文会得到/记录 409，不会重复占车。

```bash
# 方式一：为 V3 的 23L 已知短缺开新补车请求（合成台返回 D40）
node water.mjs request-shortage --village V3 --key N33-V3-SHORT-001
node water.mjs inspect --key N33-V3-SHORT-001

# 方式二：不新增车次，从 D31 相对 V2 已确认缺口确定多出的 130L 中改派 23L 给 V3
node water.mjs reassign \
  --order D31 --from V2 --to V3 --litres 23 \
  --key N33-D31-TO-V3-001 \
  --reason 'V2 已承认530L/缺口220L；V3 50L小票待X2确认，23L为已知未覆盖'

node water.mjs trace D31
```

`request`、`reassign` 成功后会保存请求 key、HTTP 状态、`sourceRef`、返回的 `order`、`result` 和按回执认定的 `acceptedL`。`departed` 订单会在本地被拒绝改派并给出值班员超额提示。程序化接口从 `index.mjs` 导出，测试使用 `npm test`。


`wire/` 保存发布方的原始载荷，`wire.json` 记录各阶段可访问的路由，便于人工对照接口。
