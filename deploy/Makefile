TAG ?= latest
REMOTE ?= root@prod
REMOTE_DIR ?= /root/clo
STATUS_URL ?= https://clo.vf.lc/status-9c8e0f3a2b71

.PHONY: deploy verify sync-compose

sync-compose:
	ssh $(REMOTE) "mkdir -p $(REMOTE_DIR)"
	scp docker-compose.yml $(REMOTE):$(REMOTE_DIR)/docker-compose.yml

deploy: sync-compose
	ssh $(REMOTE) "cd $(REMOTE_DIR) && IMAGE_TAG=$(TAG) docker compose up -d --wait app cloudflared"
	$(MAKE) verify

verify:
	curl -fsS $(STATUS_URL) && echo
