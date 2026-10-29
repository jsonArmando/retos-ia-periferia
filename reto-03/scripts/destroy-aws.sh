#!/usr/bin/env bash
# Elimina el servicio ECS Express de este reto (el repositorio ECR y los roles se conservan).
set -euo pipefail
REGION="${AWS_REGION:-us-east-1}"
APP="$(grep -m1 '"name"' package.json | cut -d'"' -f4)"
SVC_ARN=$(aws ecs list-services --cluster default --region "$REGION" --query "serviceArns[?contains(@, '/${APP}')]|[0]" --output text)
aws ecs delete-express-gateway-service --region "$REGION" --service-arn "$SVC_ARN" --monitor-resources
