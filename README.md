# pulumi-platform-lab

> **SANDBOX.** Repo này là lab học tập: chỉ chạy trong một AWS account sandbox, tạo/xoá resource
> thường xuyên, không chứa và không dành cho workload production. Không có state, secret hay
> access key trong repo.

Một worker `SQS + DLQ + Lambda` viết bằng Pulumi (TypeScript), dùng để luyện CI/CD: GitHub Actions,
AWS OIDC (không dùng access key dài hạn), deploy theo environment và môi trường tạm theo pull request.

## Cấu trúc

```text
.github/workflows/   # Workflow CI/deploy/PR environment (thêm dần)
infra/worker/        # Pulumi project `platform-worker`: components/, handlers/, tests/, index.ts
docs/migration/      # Runbook/bằng chứng migration, chỉ đưa vào sau khi đã kiểm tra nội dung
scripts/             # Script vòng đời PR environment và reaper (thêm sau)
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
Tên vật lý của function, log group, source queue và DLQ đều chứa tên stack
(ví dụ `platform-worker-dev`, `platform-worker-pr-12`) nên các stack không va nhau.

### Config của PR stack

| Key | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `prNumber` | có | Phải khớp số trong tên stack (`pr-12` ↔ `12`) |
| `expiresAt` | có | ISO-8601 UTC kết thúc bằng `Z`, ví dụ `2026-11-13T10:00:00Z` |
| `repository` | không | `OWNER/REPO`, gắn thành tag `Repository` |

Stack `dev`/`test`/`prod` không được mang các key này. PR stack gắn tag `Purpose=pr-environment`,
`PR`, `ExpiresAt` (và `Repository` nếu có) lên mọi resource hỗ trợ tags.

## Quy ước dọn dẹp (TTL 24 giờ)

PR stack tồn tại tối đa **24 giờ** kể từ lúc tạo. PR đóng thì stack bị destroy; PR còn mở nhưng
quá TTL cũng bị dọn. Tag không tự xoá resource: phần dọn do workflow đóng PR và reaper (thêm sau) thực hiện.
Stack `dev`, `test`, `prod` không bao giờ nằm trong phạm vi reaper.

## Tình trạng

Mới hoàn thành phần đóng gói repo và code/tests. Workflow, OIDC, deploy và PR environment
chưa có; README này sẽ được cập nhật khi từng phần có bằng chứng chạy thật.
