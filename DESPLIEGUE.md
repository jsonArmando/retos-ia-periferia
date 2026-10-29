# Despliegue de los 3 retos en AWS (ECS Express Mode + Bedrock)

Prerrequisitos (una vez): AWS CLI v2 actualizado, Docker con buildx, Bun ≥ 1.1, y en la consola de **Amazon Bedrock → Model catalog** habilitar *Claude Sonnet 4.5* (Anthropic pide el formulario de caso de uso la primera vez) en `us-east-1`.

```bash
export AWS_REGION=us-east-1
export ACCESS_KEY="elige-una-clave"     # opcional: protege los links
for r in reto-01 reto-02 reto-03; do (cd $r && bun install && bun test && ./scripts/deploy-aws.sh); done
```

Cada script imprime `https://<servicio>.ecs.us-east-1.on.aws`. Ponla en el README del reto.
Apagar tras la defensa: `(cd reto-0X && ./scripts/destroy-aws.sh)`.
