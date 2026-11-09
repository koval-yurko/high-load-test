// What the first apply ships, so Terraform can create the function before any build exists.
// scripts/deploy-service.sh replaces it; Terraform then ignores the code (lambda.tf).
exports.handler = async () => ({
  statusCode: 503,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ error: 'not deployed: run scripts/deploy-service.sh' }),
});
