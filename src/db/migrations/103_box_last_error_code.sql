-- Why a box failed, where code acts on it (agent_boxes.last_error is for people).
ALTER TABLE agent_boxes ADD COLUMN last_error_code VARCHAR(40);

-- Agora 0.4.2 refused every box made by an older release ("the container differs from what boxd
-- created") and held it as failed, so the automatic upgrade never reached it. boxd re-checks these
-- once and upgrades the ones that are still ours.
UPDATE agent_boxes SET last_error_code = 'drift_unverified'
WHERE state = 'failed' AND last_error LIKE 'Refused to start: the container differs from what boxd created%';
