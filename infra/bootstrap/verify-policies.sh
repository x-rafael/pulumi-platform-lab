#!/usr/bin/env bash
# Kiểm tra permission policy của 4 role CI bằng IAM policy simulator (chỉ đọc, không đổi gì trên AWS).
#
# Chạy bằng credentials admin của sandbox:  AWS_PROFILE=<profile> ./verify-policies.sh
#
# Phạm vi: simulator đánh giá IDENTITY policy của role. Nó KHÔNG kiểm tra trust policy (phần đó chứng minh
# bằng job OIDC thật, xem .github/workflows/oidc-check.yml) và KHÔNG cho biết provider Pulumi thực sự gọi
# những API nào. Quyền đủ để deploy chỉ được xác nhận khi chạy CI thật (ghi AccessDenied ở docs/ci-access.md).
set -euo pipefail

REGION="${AWS_DEFAULT_REGION:-ap-southeast-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
export AWS_PAGER=""

Q="arn:aws:sqs:${REGION}:${ACCOUNT}"
L="arn:aws:lambda:${REGION}:${ACCOUNT}"
G="arn:aws:logs:${REGION}:${ACCOUNT}:log-group:/aws/lambda"
I="arn:aws:iam::${ACCOUNT}"
LAMBDA_ONLY="iam:PassedToService=lambda.amazonaws.com"
EC2_ONLY="iam:PassedToService=ec2.amazonaws.com"

pass=0
fail=0

# check <role> <action> <resource> <expected: allowed|denied|explicitDeny> [ctxKey=ctxValue]
check() {
  local role="$1" action="$2" resource="$3" expected="$4" ctx="${5:-}"
  local args=(--policy-source-arn "${I}:role/${role}" --action-names "$action" --resource-arns "$resource")
  if [ -n "$ctx" ]; then
    args+=(--context-entries "ContextKeyName=${ctx%%=*},ContextKeyValues=${ctx#*=},ContextKeyType=string")
  fi
  local got
  got="$(aws iam simulate-principal-policy "${args[@]}" --query 'EvaluationResults[0].EvalDecision' --output text)"
  # "denied" = implicitDeny hoặc explicitDeny; "explicitDeny" chỉ khớp explicitDeny.
  local ok=0
  case "$expected" in
    allowed) [ "$got" = "allowed" ] && ok=1 ;;
    denied) { [ "$got" = "implicitDeny" ] || [ "$got" = "explicitDeny" ]; } && ok=1 ;;
    explicitDeny) [ "$got" = "explicitDeny" ] && ok=1 ;;
  esac
  local shown="${resource//${ACCOUNT}/<account>}"
  if [ "$ok" = 1 ]; then
    pass=$((pass + 1)); printf 'PASS  %-16s %-34s %-11s %s%s\n' "$role" "$action" "$got" "${shown#arn:aws:}" "${ctx:+  [$ctx]}"
  else
    fail=$((fail + 1)); printf 'FAIL  %-16s %-34s got=%s want=%s %s\n' "$role" "$action" "$got" "$expected" "$shown"
  fi
}

echo "== lab-deploy-dev: quản lý đúng stack dev =="
check lab-deploy-dev sqs:CreateQueue "$Q:platform-worker-dev-queue" allowed
check lab-deploy-dev sqs:TagQueue "$Q:platform-worker-dev-dlq" allowed
check lab-deploy-dev sqs:CreateQueue "$Q:platform-worker-pr-12-queue" denied
check lab-deploy-dev sqs:CreateQueue "$Q:platform-worker-prod-queue" denied
check lab-deploy-dev sqs:CreateQueue "$Q:unrelated-queue" denied
check lab-deploy-dev lambda:CreateFunction "$L:function:platform-worker-dev" allowed
check lab-deploy-dev lambda:CreateFunction "$L:function:platform-worker-pr-12" denied
check lab-deploy-dev logs:CreateLogGroup "$G/platform-worker-dev" allowed
check lab-deploy-dev logs:CreateLogGroup "$G/platform-worker-pr-12" denied
check lab-deploy-dev iam:CreateRole "$I:role/platform-worker-dev-role" allowed
check lab-deploy-dev iam:CreateRole "$I:role/platform-worker-pr-12-role" denied
check lab-deploy-dev iam:CreateRole "$I:role/some-admin-role" denied
# CreateEventSourceMapping: Resource "*" bắt buộc (không có resource-level), giới hạn bằng lambda:FunctionArn.
check lab-deploy-dev lambda:CreateEventSourceMapping "*" allowed "lambda:FunctionArn=$L:function:platform-worker-dev"
check lab-deploy-dev lambda:CreateEventSourceMapping "*" denied "lambda:FunctionArn=$L:function:platform-worker-pr-12"
check lab-deploy-dev lambda:CreateEventSourceMapping "*" denied "lambda:FunctionArn=$L:function:other-function"
check lab-deploy-dev lambda:CreateEventSourceMapping "*" denied
check lab-deploy-dev lambda:UpdateEventSourceMapping "$L:event-source-mapping:*" allowed "lambda:FunctionArn=$L:function:platform-worker-dev"
check lab-deploy-dev lambda:UpdateEventSourceMapping "$L:event-source-mapping:*" denied "lambda:FunctionArn=$L:function:platform-worker-pr-12"
# Destroy: provider poll GetEventSourceMapping tới khi mapping biến mất; lúc đó IAM đánh giá với Resource "*" (AccessDenied thật).
check lab-deploy-dev lambda:GetEventSourceMapping "*" allowed
check lab-deploy-prod lambda:GetEventSourceMapping "*" allowed
check lab-pr-env lambda:GetEventSourceMapping "*" allowed
check lab-preview lambda:GetEventSourceMapping "*" denied
echo "-- smoke test: chỉ gửi vào source queue"
check lab-deploy-dev sqs:SendMessage "$Q:platform-worker-dev-queue" allowed
check lab-deploy-dev sqs:SendMessage "$Q:platform-worker-dev-dlq" denied
check lab-deploy-dev logs:FilterLogEvents "$G/platform-worker-dev:*" allowed
echo "-- PassRole: đúng role, chỉ cho Lambda"
check lab-deploy-dev iam:PassRole "$I:role/platform-worker-dev-role" allowed "$LAMBDA_ONLY"
check lab-deploy-dev iam:PassRole "$I:role/platform-worker-dev-role" denied "$EC2_ONLY"
check lab-deploy-dev iam:PassRole "$I:role/platform-worker-pr-12-role" denied "$LAMBDA_ONLY"
check lab-deploy-dev iam:PassRole "$I:role/lab-deploy-prod" denied "$LAMBDA_ONLY"
echo "-- không đụng đường vào CI, không có quyền ngoài phạm vi"
check lab-deploy-dev iam:UpdateAssumeRolePolicy "$I:role/lab-deploy-dev" explicitDeny
check lab-deploy-dev iam:PutRolePolicy "$I:role/lab-deploy-dev" explicitDeny
check lab-deploy-dev iam:UpdateAssumeRolePolicy "$I:role/lab-pr-env" explicitDeny
check lab-deploy-dev iam:DeleteOpenIDConnectProvider "${I}:oidc-provider/token.actions.githubusercontent.com" explicitDeny
check lab-deploy-dev iam:CreateUser "$I:user/x" denied
check lab-deploy-dev iam:AttachRolePolicy "$I:role/platform-worker-dev-role" denied
check lab-deploy-dev s3:CreateBucket "arn:aws:s3:::any-bucket" denied

echo "== lab-pr-env: chỉ stack pr-* =="
check lab-pr-env sqs:CreateQueue "$Q:platform-worker-pr-12-queue" allowed
check lab-pr-env sqs:CreateQueue "$Q:platform-worker-pr-999-dlq" allowed
check lab-pr-env sqs:CreateQueue "$Q:platform-worker-dev-queue" denied
check lab-pr-env sqs:CreateQueue "$Q:platform-worker-prod-queue" denied
check lab-pr-env lambda:UpdateFunctionCode "$L:function:platform-worker-pr-12" allowed
check lab-pr-env lambda:UpdateFunctionCode "$L:function:platform-worker-dev" denied
check lab-pr-env lambda:UpdateFunctionCode "$L:function:platform-worker-prod" denied
check lab-pr-env iam:PassRole "$I:role/platform-worker-pr-12-role" allowed "$LAMBDA_ONLY"
check lab-pr-env iam:PassRole "$I:role/platform-worker-dev-role" denied "$LAMBDA_ONLY"
check lab-pr-env iam:PutRolePolicy "$I:role/platform-worker-dev-role" denied
check lab-pr-env iam:UpdateAssumeRolePolicy "$I:role/lab-pr-env" explicitDeny

echo "== lab-deploy-prod: chỉ stack prod =="
check lab-deploy-prod sqs:CreateQueue "$Q:platform-worker-prod-queue" allowed
check lab-deploy-prod sqs:CreateQueue "$Q:platform-worker-dev-queue" denied
check lab-deploy-prod sqs:CreateQueue "$Q:platform-worker-pr-12-queue" denied
check lab-deploy-prod iam:PassRole "$I:role/platform-worker-prod-role" allowed "$LAMBDA_ONLY"
check lab-deploy-prod iam:PassRole "$I:role/platform-worker-dev-role" denied "$LAMBDA_ONLY"
check lab-deploy-prod iam:UpdateAssumeRolePolicy "$I:role/lab-deploy-prod" explicitDeny

echo "== lab-preview: chỉ đọc stack dev =="
check lab-preview sqs:GetQueueAttributes "$Q:platform-worker-dev-queue" allowed
check lab-preview lambda:GetFunction "$L:function:platform-worker-dev" allowed
check lab-preview iam:GetRole "$I:role/platform-worker-dev-role" allowed
check lab-preview logs:ListTagsForResource "$G/platform-worker-dev" allowed
check lab-preview sqs:GetQueueAttributes "$Q:platform-worker-prod-queue" denied
check lab-preview sqs:GetQueueAttributes "$Q:platform-worker-pr-12-queue" denied
check lab-preview sqs:CreateQueue "$Q:platform-worker-dev-queue" denied
check lab-preview sqs:SendMessage "$Q:platform-worker-dev-queue" denied
check lab-preview lambda:UpdateFunctionCode "$L:function:platform-worker-dev" denied
check lab-preview iam:CreateRole "$I:role/platform-worker-dev-role" denied
check lab-preview iam:PassRole "$I:role/platform-worker-dev-role" denied "$LAMBDA_ONLY"
check lab-preview iam:UpdateAssumeRolePolicy "$I:role/lab-preview" explicitDeny

echo
echo "Tổng: ${pass} PASS, ${fail} FAIL"
[ "$fail" -eq 0 ]
