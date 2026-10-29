#!/usr/bin/env bash
# Despliega este reto en AWS: ECR + ECS Express Mode (Fargate + ALB HTTPS público) + Bedrock vía rol de tarea.
# Requisitos: AWS CLI v2 reciente (con "aws ecs create-express-gateway-service"), Docker con buildx, credenciales con permisos de IAM/ECR/ECS.
# Uso: ./scripts/deploy-aws.sh            (desde la raíz del reto)
#      ACCESS_KEY=mi-clave ./scripts/deploy-aws.sh   (protege el link)
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
MODEL="${BEDROCK_MODEL_ID:-us.anthropic.claude-sonnet-4-5-20250929-v1:0}"
APP="$(grep -m1 '"name"' package.json | cut -d'"' -f4)"            # p. ej. reto-01-registro-proveedor
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REPO="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com/${APP}"
TAG="$(date +%Y%m%d%H%M%S)"
TASK_ROLE="periferia-agente-bedrock-task"

echo "▶ ${APP} → cuenta ${ACCOUNT} / ${REGION}"

# 1) Imagen en ECR (linux/amd64: Fargate por defecto es X86_64)
aws ecr describe-repositories --repository-names "$APP" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$APP" --region "$REGION" --image-scanning-configuration scanOnPush=true >/dev/null
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
docker buildx build --platform linux/amd64 -t "${REPO}:${TAG}" --push .

# 2) Roles IAM (idempotente)
ensure_role () { # $1 nombre, $2 servicio principal
  aws iam get-role --role-name "$1" >/dev/null 2>&1 || aws iam create-role --role-name "$1" \
    --assume-role-policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"$2\"},\"Action\":\"sts:AssumeRole\"}]}" >/dev/null
}
ensure_role ecsTaskExecutionRole ecs-tasks.amazonaws.com
aws iam attach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
ensure_role ecsInfrastructureRoleForExpressServices ecs.amazonaws.com
aws iam attach-role-policy --role-name ecsInfrastructureRoleForExpressServices --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices
ensure_role "$TASK_ROLE" ecs-tasks.amazonaws.com
aws iam put-role-policy --role-name "$TASK_ROLE" --policy-name bedrock-invoke --policy-document '{
  "Version":"2012-10-17",
  "Statement":[{"Effect":"Allow","Action":["bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],
  "Resource":["arn:aws:bedrock:*::foundation-model/anthropic.*","arn:aws:bedrock:*:'"$ACCOUNT"':inference-profile/*"]}]}'

ARN () { echo "arn:aws:iam::${ACCOUNT}:role/$1"; }
CONTAINER=$(cat <<EOF
{"image":"${REPO}:${TAG}","containerPort":8080,
 "environment":[
  {"name":"LLM_PROVIDER","value":"bedrock"},{"name":"AWS_REGION","value":"${REGION}"},
  {"name":"BEDROCK_MODEL_ID","value":"${MODEL}"},{"name":"MAX_ITERACIONES","value":"25"},
  {"name":"MAX_TOKENS_SESION","value":"400000"},{"name":"RATE_LIMIT_POR_MINUTO","value":"20"},
  {"name":"ACCESS_KEY","value":"${ACCESS_KEY:-}"},{"name":"FECHA_REFERENCIA","value":"${FECHA_REFERENCIA:-}"}]}
EOF
)

# 3) Servicio ECS Express (crear o actualizar)
SVC_ARN=$(aws ecs list-services --cluster default --region "$REGION" --query "serviceArns[?contains(@, '/${APP}')]|[0]" --output text 2>/dev/null || true)
if [[ -z "$SVC_ARN" || "$SVC_ARN" == "None" ]]; then
  sleep 10 # consistencia eventual de IAM en el primer despliegue
  aws ecs create-express-gateway-service --region "$REGION" \
    --service-name "$APP" \
    --execution-role-arn "$(ARN ecsTaskExecutionRole)" \
    --infrastructure-role-arn "$(ARN ecsInfrastructureRoleForExpressServices)" \
    --task-role-arn "$(ARN "$TASK_ROLE")" \
    --primary-container "$CONTAINER" \
    --cpu 512 --memory 1024 \
    --health-check-path "/api/health" \
    --scaling-target '{"minTaskCount":1,"maxTaskCount":1}' \
    --monitor-resources
  SVC_ARN=$(aws ecs list-services --cluster default --region "$REGION" --query "serviceArns[?contains(@, '/${APP}')]|[0]" --output text)
else
  aws ecs update-express-gateway-service --region "$REGION" --service-arn "$SVC_ARN" \
    --primary-container "$CONTAINER" --monitor-resources
fi

URL=$(aws ecs describe-express-gateway-service --region "$REGION" --service-arn "$SVC_ARN" \
  --query 'service.activeConfigurations[0].ingressPaths[?accessType==`PUBLIC`].endpoint|[0]' --output text)
echo "✅ ${APP} desplegado: https://${URL#https://}"
echo "   Prueba: curl -s https://${URL#https://}/api/health"
