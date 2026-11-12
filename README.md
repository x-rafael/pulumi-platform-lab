# pulumi-platform-lab

> **SANDBOX.** Repo này là lab học tập: chỉ chạy trong một AWS account sandbox, tạo/xoá resource
> thường xuyên, không chứa và không dành cho workload production. Không có state, secret hay
> access key trong repo.

Một worker `SQS + DLQ + Lambda` viết bằng Pulumi (TypeScript), dùng để luyện CI/CD: GitHub Actions,
AWS OIDC (không dùng access key dài hạn), deploy theo environment và môi trường tạm theo pull request.

## Cấu trúc

```text
.github/workflows/   # Workflow CI/deploy/PR environment (thêm dần); hiện có oidc-check.yml
infra/worker/        # Pulumi project `platform-worker`: components/, handlers/, tests/, index.ts
infra/bootstrap/     # Pulumi project `platform-ci-bootstrap`: OIDC provider + role CI (chỉ admin chạy ở máy local)
docs/ci-access.md    # CI truy cập AWS thế nào: trust/permission, bằng chứng kiểm chứng, nhật ký AccessDenied, giới hạn đã biết
docs/pr-environments.md  # PR environment: vòng đời, quy tắc an toàn, bảng quyết định của reaper, bằng chứng
docs/runbook.md      # Vận hành: đang chạy gì, ai sở hữu, lệnh thường dùng, xử lý sự cố, thứ tự gỡ hoàn toàn
docs/migration/      # Runbook/bằng chứng migration, chỉ đưa vào sau khi đã kiểm tra nội dung
scripts/             # pr-env.ts: vòng đời PR environment (up, destroy) và reaper; logic quyết định là hàm thuần có test
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

## Quy ước dọn dẹp (TTL 24 giờ)

PR stack tồn tại tối đa **24 giờ** kể từ lúc tạo (push thêm commit không kéo dài). PR đóng thì stack bị destroy; PR còn mở nhưng quá TTL cũng bị dọn. Tag không tự xoá resource: việc dọn do workflow đóng PR và reaper thực hiện. Reaper chạy **mỗi 6 giờ và dọn thật** cho tới khi bị tắt (`gh workflow disable "PR environment reaper"`; GitHub cũng tự tắt workflow theo lịch của repo public sau 60 ngày không có hoạt động). Stack `dev`, `test`, `prod` không bao giờ nằm trong phạm vi reaper. Chi tiết ở [docs/pr-environments.md](docs/pr-environments.md).

## Tình trạng

- Có: repo, code/tests của worker; OIDC provider + 4 role CI; CI cho PR (`unit` + `preview`; cả AWS lẫn Pulumi Cloud đăng nhập bằng OIDC, không có secret tĩnh);
  deploy stack `dev` khi push vào `main` kèm smoke test; cổng phê duyệt cho environment `prod` (chỉ preview); **PR environment** (tạo, cập nhật, xoá khi đóng PR) và **reaper TTL 24 giờ**,
  đều có bằng chứng chạy thật. Xem [docs/ci-access.md](docs/ci-access.md) và [docs/pr-environments.md](docs/pr-environments.md).
- Giới hạn đã biết: chỉ có một người dùng nên cổng `prod` là owner tự phê duyệt; ruleset `main` bắt buộc check `unit` nhưng chủ repo được bypass; không có merge queue (repo thuộc tài khoản cá nhân).
- Đã dọn dẹp (2026-11-12): stack `dev` đã destroy bằng role CI và xác nhận rỗng; workflow `Deploy dev` **đang tắt** (bật lại bằng `gh workflow enable "Deploy dev"`). Còn lại có chủ đích: bootstrap OIDC/roles (owner Rafael) và reaper theo lịch. Xem [docs/runbook.md](docs/runbook.md).
