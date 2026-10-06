-- 000013_schedule_space: user schedules target one owned space. System
-- schedules keep NULL (doc 13 §4.1: 自动备份/链接检查都按 Space 执行).
ALTER TABLE schedules ADD COLUMN space_id TEXT REFERENCES sync_spaces(id);
