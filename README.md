# pulumi-platform-lab

> **SANDBOX.** Repo này là lab học tập: chỉ chạy trong một AWS account sandbox, tạo/xoá resource
> thường xuyên, không chứa và không dành cho workload production. Không có state, secret hay
> access key trong repo.

Một worker `SQS + DLQ + Lambda` viết bằng Pulumi (TypeScript), dùng để luyện CI/CD: GitHub Actions,
AWS OIDC (không dùng access key dài hạn), deploy theo environment và môi trường tạm theo pull request.
Có thêm một project cấu hình dùng chung (`platform-config`) mà worker đọc qua StackReference, và một deploy CLI
(Pulumi Automation API) điều phối preview/apply/check theo thứ tự phụ thuộc giữa hai project.

## Cấu trúc

```text
.github/workflows/   # Workflow: ci, deploy-dev, destroy-dev, prod-preview, pr-env-destroy, pr-env-reaper, oidc-check
infra/worker/        # Pulumi project `platform-worker`: components/, handlers/, tests/, index.ts
infra/config/        # Pulumi project `platform-config`: SSM parameter dùng chung (message-prefix); worker đọc output của nó qua StackReference
infra/bootstrap/     # Pulumi project `platform-ci-bootstrap`: OIDC provider + role CI (chỉ admin chạy ở máy local)
docs/ci-access.md    # CI truy cập AWS thế nào: trust/permission, bằng chứng kiểm chứng, nhật ký AccessDenied, giới hạn đã biết
docs/pr-environments.md  # PR environment: vòng đời, quy tắc an toàn, bảng quyết định của reaper, bằng chứng
docs/runbook.md      # Vận hành: đang chạy gì, ai sở hữu, lệnh thường dùng, xử lý sự cố, thứ tự gỡ hoàn toàn
docs/migration/      # Runbook/bằng chứng migration, chỉ đưa vào sau khi đã kiểm tra nội dung
scripts/             # pr-env.ts: vòng đời PR environment (up, destroy) và reaper; logic quyết định là hàm thuần có test
tools/deploy-cli/    # Deploy CLI (TypeScript, Pulumi Automation API): preview/apply/check, nhiều domain theo thứ tự phụ thuộc
```

## Kiểm tra local

Cần Node 24. Chạy trong `infra/worker`:

```bash
npm ci
npm run typecheck
npm test
npm run build:handler   # tạo dist/worker.js, Pulumi đọc artifact này khi deploy
```

Unit tests dùng mocks của Pulumi, không gọi AWS.

`infra/config` và `tools/deploy-cli` dùng cùng ba lệnh (`npm ci`, `npm run typecheck`, `npm test`); test của deploy CLI dùng
adapter giả nên không gọi Pulumi hay AWS. **CI hiện chỉ chạy job `unit` cho `infra/worker`, `infra/bootstrap` và `scripts`**:
`infra/config` và `tools/deploy-cli` chưa có job.

## Stack và environment

Backend: **Pulumi Cloud**. Tên đầy đủ của stack dùng trong CI: `YOUR_ORG/platform-worker/<stack>`.

| Stack | `environment` | Ghi chú |
| --- | --- | --- |
| `dev` | `dev` | Deploy tự động từ `main` |
| `test` | `test` | Chỉ preview |
| `prod` | `prod` | Vẫn nằm trong sandbox; dùng để thử approval gate |
| `pr-<số nguyên dương>` | `dev` | Môi trường tạm cho một pull request |

Mapping là tường minh trong `components/workerConfig.ts`; tên stack lạ bị từ chối thay vì đoán.
Tên vật lý của function, log group, source queue, DLQ và IAM role đều chứa tên stack
(ví dụ `platform-worker-dev`, `platform-worker-pr-12`) nên các stack không va nhau, và policy của role CI
giới hạn được đúng resource của từng stack.

### Config của PR stack

| Key | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `prNumber` | có | Phải khớp số trong tên stack (`pr-12` ↔ `12`) |
| `expiresAt` | có | ISO-8601 UTC kết thúc bằng `Z`, ví dụ `2026-11-13T10:00:00Z` |
| `repository` | không | `OWNER/REPO`, gắn thành tag `Repository` |

Stack `dev`/`test`/`prod` không được mang các key này. PR stack gắn tag `Purpose=pr-environment`,
`PR`, `ExpiresAt` (và `Repository` nếu có) lên mọi resource hỗ trợ tags.

### Config dùng chung (`platform-config`)

Project `platform-config` sở hữu SSM String parameter `/platform-lab/<env>/message-prefix` (giá trị `lab`, **không bí mật**) và
export `messagePrefix`. Worker không tạo lại parameter, chỉ đọc output đó:

| Key của worker | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `configStack` | không | Tên đầy đủ `YOUR_ORG/platform-config/<stack>`. Project phải là `platform-config` và stack phải trùng environment của worker. Có thì Lambda nhận `MESSAGE_PREFIX` từ output `messagePrefix` (handler ghi vào log); không có (vd. stack PR) thì dùng prefix mặc định `lab` và không có StackReference nào |

StackReference chỉ **đọc** output, Pulumi không tự deploy stack được tham chiếu. Vì vậy config phải được deploy **trước** worker
(deploy CLI điều phối thứ tự) và khi dọn thì dọn worker **trước**, config sau. Thiếu output thì preview của worker báo
`Required output 'messagePrefix' does not exist on stack …` thay vì dùng giá trị bịa.

## Deploy CLI (`tools/deploy-cli`)

```bash
cd tools/deploy-cli
export AWS_PROFILE=<profile sandbox> PULUMI_ORG=<tổ chức Pulumi>
npm run -s deploy -- --domain worker --env dev          # preview (mặc định): không đổi AWS
npm run -s deploy -- --domain all --env dev --check     # config → worker; exit 2 nếu có thay đổi
npm run -s deploy -- --domain all --env dev --apply     # preview rồi up khi policy cho phép
```

- **Domain:** `config`, `worker`, `all`. `all` chạy config trước worker; `--domain worker` chạy đúng worker, không kéo theo config.
  **Environment:** `dev|test|prod`, nhưng `--apply` chỉ cho `dev`.
- **Luôn dùng `npm run -s`** khi cần đọc stdout bằng máy: không có `-s`, npm in banner `> deploy-cli@1.0.0 deploy` ra stdout.
  stdout là một JSON summary (mỗi domain một báo cáo: trạng thái, `changeSummary`, outputs đã che secret, thời gian);
  tiến trình đi ra stderr.
- **Chỉ chọn stack có sẵn (`selectStack`)**: gõ sai tên thì báo thiếu stack, không bao giờ tạo stack. Tạo stack là bước bootstrap
  có chủ đích (`pulumi stack init`).
- **Gate:** `--apply` chỉ chạy `up` khi preview chỉ gồm `same/create/update/read/refresh` (chặn delete và replace); `--check`
  chặt hơn: báo mọi operation khác `same`. Preview rồi `up` không phải một transaction; CLI chạy lại policy trên kết quả thật của `up`.
- **Exit code:** `0` thành công · `1` lỗi vận hành hoặc config (có domain `failed`) · `2` gate chặn, check thấy thay đổi, hoặc domain bị
  skip · `64` input sai hoặc `--apply` bị từ chối. Mã `3` (stack đang bị lock) và `130` (Ctrl-C) chưa làm.
- `selectStack` làm đổi stack đang chọn của thư mục `infra/*`: khi gõ `pulumi` tay luôn truyền `--stack`.

## Quy ước dọn dẹp (TTL 24 giờ)

PR stack tồn tại tối đa **24 giờ** kể từ lúc tạo (push thêm commit không kéo dài). PR đóng thì stack bị destroy; PR còn mở nhưng quá TTL cũng bị dọn. Tag không tự xoá resource: việc dọn do workflow đóng PR và reaper thực hiện. Reaper chạy **mỗi 6 giờ và dọn thật** cho tới khi bị tắt (`gh workflow disable "PR environment reaper"`; GitHub cũng tự tắt workflow theo lịch của repo public sau 60 ngày không có hoạt động). Stack `dev`, `test`, `prod` không bao giờ nằm trong phạm vi reaper. Chi tiết ở [docs/pr-environments.md](docs/pr-environments.md).

## Tình trạng

- Có: repo, code/tests của worker; OIDC provider + 4 role CI; CI cho PR (`unit` + `preview`; cả AWS lẫn Pulumi Cloud đăng nhập bằng OIDC, không có secret tĩnh);
  deploy stack `dev` khi push vào `main` kèm smoke test; cổng phê duyệt cho environment `prod` (chỉ preview); **PR environment** (tạo, cập nhật, xoá khi đóng PR) và **reaper TTL 24 giờ**,
  đều có bằng chứng chạy thật. Xem [docs/ci-access.md](docs/ci-access.md) và [docs/pr-environments.md](docs/pr-environments.md).
- Có thêm (2026-11-13): project `platform-config` (SSM parameter) + worker đọc qua StackReference, và deploy CLI (preview/apply/check, nhiều domain theo thứ tự phụ thuộc), đều có bằng chứng chạy thật trên `dev`.
- Giới hạn đã biết: chỉ có một người dùng nên cổng `prod` là owner tự phê duyệt; ruleset `main` bắt buộc check `unit` nhưng chủ repo được bypass; không có merge queue (repo thuộc tài khoản cá nhân).
- **CI chưa biết về `platform-config`:** job `preview` của CI nhắm stack `dev`, mà stack này giờ có `configStack`, nên token Pulumi của CI phải đọc được `platform-config/dev` (chưa kiểm chứng); role CI không có quyền SSM; `infra/config` và `tools/deploy-cli` chưa có job test; `destroy-dev.yml` chỉ dọn worker. Giải quyết trước khi bật lại `Deploy dev`.
- Lịch sử `dev`: 2026-11-12 đã destroy bằng role CI và xác nhận rỗng; 2026-11-13 dựng lại **bằng deploy CLI từ máy local (admin SSO, không phải role CI)**: `platform-worker/dev` 11 resource + 1 StackReference, `platform-config/dev` 1 SSM parameter. Workflow `Deploy dev` **vẫn tắt** (bật lại bằng `gh workflow enable "Deploy dev"`). Còn lại có chủ đích: bootstrap OIDC/roles (owner Rafael) và reaper theo lịch. Xem [docs/runbook.md](docs/runbook.md).
