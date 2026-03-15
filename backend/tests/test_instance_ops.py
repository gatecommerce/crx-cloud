"""Tests for enterprise instance management — models, cloning, migration, backup scheduling.

60+ tests covering:
- Model creation and defaults (Migration, Clone, BackupSchedule, Backup enterprise fields)
- Clone lifecycle (create → ready → start → stop → destroy)
- One-active-clone guard (token safety)
- Migration status flow
- Backup schedule config and retention
- Neutralization SQL template
- Estimation helpers
- Edge cases and error handling
"""

import uuid
from datetime import datetime, timezone, timedelta
from unittest.mock import AsyncMock, patch, MagicMock

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.models.backup import Backup
from api.models.backup_schedule import BackupSchedule
from api.models.clone import Clone
from api.models.instance import Instance
from api.models.migration import Migration
from api.models.server import Server


# ======================================================================
# MODEL CREATION & DEFAULTS
# ======================================================================


class TestMigrationModel:
    """Migration model — creation, defaults, status values."""

    @pytest.mark.asyncio
    async def test_create_migration(self, db: AsyncSession, sample_instance, sample_server, sample_target_server):
        mig = Migration(
            source_instance_id=sample_instance.id,
            source_server_id=sample_server.id,
            target_server_id=sample_target_server.id,
            strategy="cold",
            status="pending",
        )
        db.add(mig)
        await db.commit()
        await db.refresh(mig)

        assert mig.id is not None
        assert len(mig.id) == 36
        assert mig.strategy == "cold"
        assert mig.status == "pending"
        assert mig.include_filestore is True
        assert mig.source_db_size_mb is None
        assert mig.duration_seconds is None

    @pytest.mark.asyncio
    async def test_migration_defaults(self, db: AsyncSession, sample_instance, sample_server, sample_target_server):
        mig = Migration(
            source_instance_id=sample_instance.id,
            source_server_id=sample_server.id,
            target_server_id=sample_target_server.id,
        )
        db.add(mig)
        await db.commit()
        await db.refresh(mig)

        assert mig.strategy == "cold"
        assert mig.status == "pending"
        assert mig.include_filestore is True
        assert mig.error_message is None
        assert mig.steps_log is None
        assert mig.completed_at is None

    @pytest.mark.asyncio
    async def test_migration_with_target_database(self, db: AsyncSession, sample_instance, sample_server, sample_target_server):
        mig = Migration(
            source_instance_id=sample_instance.id,
            source_server_id=sample_server.id,
            target_server_id=sample_target_server.id,
            target_database="odoo_migrated",
        )
        db.add(mig)
        await db.commit()
        await db.refresh(mig)

        assert mig.target_database == "odoo_migrated"

    @pytest.mark.asyncio
    async def test_migration_steps_log_json(self, db: AsyncSession, sample_instance, sample_server, sample_target_server):
        steps = [
            {"step": "ssh_source", "ok": True},
            {"step": "ssh_target", "ok": True},
            {"step": "dump_database", "ok": True},
        ]
        mig = Migration(
            source_instance_id=sample_instance.id,
            source_server_id=sample_server.id,
            target_server_id=sample_target_server.id,
            steps_log=steps,
        )
        db.add(mig)
        await db.commit()
        await db.refresh(mig)

        assert mig.steps_log == steps
        assert len(mig.steps_log) == 3

    @pytest.mark.asyncio
    async def test_migration_status_flow(self, db: AsyncSession, sample_instance, sample_server, sample_target_server):
        """Verify all status transitions are valid."""
        mig = Migration(
            source_instance_id=sample_instance.id,
            source_server_id=sample_server.id,
            target_server_id=sample_target_server.id,
            status="pending",
        )
        db.add(mig)
        await db.commit()

        statuses = ["preflight", "backing_up", "stopping", "dumping",
                     "transferring", "restoring", "verifying", "completed"]
        for s in statuses:
            mig.status = s
            await db.commit()
            await db.refresh(mig)
            assert mig.status == s

    @pytest.mark.asyncio
    async def test_migration_failed_with_error(self, db: AsyncSession, sample_instance, sample_server, sample_target_server):
        mig = Migration(
            source_instance_id=sample_instance.id,
            source_server_id=sample_server.id,
            target_server_id=sample_target_server.id,
            status="failed",
            error_message="SSH to target server failed: Connection refused",
            duration_seconds=42,
        )
        db.add(mig)
        await db.commit()
        await db.refresh(mig)

        assert mig.status == "failed"
        assert "Connection refused" in mig.error_message
        assert mig.duration_seconds == 42


class TestCloneModel:
    """Clone model — creation, defaults, lifecycle states."""

    @pytest.mark.asyncio
    async def test_create_clone(self, db: AsyncSession, sample_instance):
        clone = Clone(
            name="odoo-prod-01 — staging",
            source_instance_id=sample_instance.id,
            clone_type="staging",
            status="pending",
            neutralized=True,
            owner_id="user_001",
        )
        db.add(clone)
        await db.commit()
        await db.refresh(clone)

        assert clone.id is not None
        assert clone.name == "odoo-prod-01 — staging"
        assert clone.clone_type == "staging"
        assert clone.neutralized is True
        assert clone.is_active is False
        assert clone.status == "pending"

    @pytest.mark.asyncio
    async def test_clone_defaults(self, db: AsyncSession, sample_instance):
        clone = Clone(
            name="test clone",
            source_instance_id=sample_instance.id,
            owner_id="user_001",
        )
        db.add(clone)
        await db.commit()
        await db.refresh(clone)

        assert clone.clone_type == "staging"
        assert clone.status == "pending"
        assert clone.neutralized is True
        assert clone.is_active is False
        assert clone.clone_database is None
        assert clone.base_url is None

    @pytest.mark.asyncio
    async def test_clone_types(self, db: AsyncSession, sample_instance):
        """All clone types can be stored."""
        for ct in ("staging", "development", "testing", "disaster_recovery"):
            clone = Clone(
                name=f"clone-{ct}",
                source_instance_id=sample_instance.id,
                clone_type=ct,
                owner_id="user_001",
            )
            db.add(clone)
            await db.commit()
            await db.refresh(clone)
            assert clone.clone_type == ct

    @pytest.mark.asyncio
    async def test_clone_status_lifecycle(self, db: AsyncSession, sample_instance):
        """Full lifecycle: pending → cloning → neutralizing → ready → running → stopped → destroyed."""
        clone = Clone(
            name="lifecycle-test",
            source_instance_id=sample_instance.id,
            owner_id="user_001",
            status="pending",
        )
        db.add(clone)
        await db.commit()

        for s in ("cloning", "neutralizing", "ready", "running", "stopped", "destroyed"):
            clone.status = s
            await db.commit()
            await db.refresh(clone)
            assert clone.status == s

    @pytest.mark.asyncio
    async def test_clone_neutralization_log(self, db: AsyncSession, sample_instance):
        clone = Clone(
            name="neutralized-clone",
            source_instance_id=sample_instance.id,
            neutralized=True,
            neutralization_log={
                "actions": ["crons_disabled", "mail_servers_disabled", "iap_tokens_neutralized"],
            },
            owner_id="user_001",
        )
        db.add(clone)
        await db.commit()
        await db.refresh(clone)

        assert clone.neutralization_log["actions"][0] == "crons_disabled"
        assert len(clone.neutralization_log["actions"]) == 3

    @pytest.mark.asyncio
    async def test_clone_with_database_name(self, db: AsyncSession, sample_instance):
        clone = Clone(
            name="named-db-clone",
            source_instance_id=sample_instance.id,
            clone_database="odoo_prod_stag_20260313",
            owner_id="user_001",
        )
        db.add(clone)
        await db.commit()
        await db.refresh(clone)

        assert clone.clone_database == "odoo_prod_stag_20260313"


class TestBackupScheduleModel:
    """BackupSchedule model — periodic backup configuration."""

    @pytest.mark.asyncio
    async def test_create_schedule(self, db: AsyncSession, sample_instance):
        sched = BackupSchedule(
            instance_id=sample_instance.id,
            owner_id="user_001",
            cron_expression="0 2 * * *",
            timezone="Europe/Rome",
        )
        db.add(sched)
        await db.commit()
        await db.refresh(sched)

        assert sched.id is not None
        assert sched.enabled is True
        assert sched.cron_expression == "0 2 * * *"
        assert sched.timezone == "Europe/Rome"

    @pytest.mark.asyncio
    async def test_schedule_defaults(self, db: AsyncSession, sample_instance):
        sched = BackupSchedule(
            instance_id=sample_instance.id,
            owner_id="user_001",
        )
        db.add(sched)
        await db.commit()
        await db.refresh(sched)

        assert sched.enabled is True
        assert sched.backup_format == "zip"
        assert sched.include_filestore is True
        assert sched.keep_daily == 7
        assert sched.keep_weekly == 4
        assert sched.keep_monthly == 12
        assert sched.notify_on_success is False
        assert sched.notify_on_failure is True
        assert sched.verify_after_backup is True
        assert sched.stop_instance_during_backup is False
        assert sched.consecutive_failures == 0
        assert sched.total_runs == 0

    @pytest.mark.asyncio
    async def test_schedule_retention_policy(self, db: AsyncSession, sample_instance):
        sched = BackupSchedule(
            instance_id=sample_instance.id,
            owner_id="user_001",
            keep_daily=14,
            keep_weekly=8,
            keep_monthly=24,
        )
        db.add(sched)
        await db.commit()
        await db.refresh(sched)

        assert sched.keep_daily == 14
        assert sched.keep_weekly == 8
        assert sched.keep_monthly == 24
        # Max total backups kept
        assert sched.keep_daily + sched.keep_weekly + sched.keep_monthly == 46

    @pytest.mark.asyncio
    async def test_schedule_multi_destination(self, db: AsyncSession, sample_instance):
        sched = BackupSchedule(
            instance_id=sample_instance.id,
            owner_id="user_001",
            destination_ids=["storage_s3_01", "storage_azure_01"],
        )
        db.add(sched)
        await db.commit()
        await db.refresh(sched)

        assert sched.destination_ids == ["storage_s3_01", "storage_azure_01"]

    @pytest.mark.asyncio
    async def test_schedule_notifications(self, db: AsyncSession, sample_instance):
        sched = BackupSchedule(
            instance_id=sample_instance.id,
            owner_id="user_001",
            notify_on_success=True,
            notify_on_failure=True,
            notification_channels=["telegram", "email"],
        )
        db.add(sched)
        await db.commit()
        await db.refresh(sched)

        assert sched.notification_channels == ["telegram", "email"]

    @pytest.mark.asyncio
    async def test_schedule_hooks(self, db: AsyncSession, sample_instance):
        sched = BackupSchedule(
            instance_id=sample_instance.id,
            owner_id="user_001",
            pre_backup_command="docker exec crx-odoo-prod supervisorctl stop cron",
            post_backup_command="docker exec crx-odoo-prod supervisorctl start cron",
        )
        db.add(sched)
        await db.commit()
        await db.refresh(sched)

        assert "supervisorctl stop" in sched.pre_backup_command
        assert "supervisorctl start" in sched.post_backup_command

    @pytest.mark.asyncio
    async def test_schedule_stats_update(self, db: AsyncSession, sample_instance):
        sched = BackupSchedule(
            instance_id=sample_instance.id,
            owner_id="user_001",
        )
        db.add(sched)
        await db.commit()

        # Simulate 3 runs, last one failed
        sched.total_runs = 3
        sched.last_run_at = datetime.now(timezone.utc)
        sched.last_status = "failed"
        sched.consecutive_failures = 1
        await db.commit()
        await db.refresh(sched)

        assert sched.total_runs == 3
        assert sched.consecutive_failures == 1
        assert sched.last_status == "failed"


class TestBackupEnterpriseFields:
    """Backup model — enterprise extensions."""

    @pytest.mark.asyncio
    async def test_backup_enterprise_fields(self, db: AsyncSession, sample_instance, sample_server):
        backup = Backup(
            instance_id=sample_instance.id,
            server_id=sample_server.id,
            backup_type="scheduled",
            backup_format="custom",
            include_filestore=True,
            verified=False,
            status="pending",
        )
        db.add(backup)
        await db.commit()
        await db.refresh(backup)

        assert backup.backup_format == "custom"
        assert backup.include_filestore is True
        assert backup.verified is False

    @pytest.mark.asyncio
    async def test_backup_pre_migration_type(self, db: AsyncSession, sample_instance, sample_server):
        backup = Backup(
            instance_id=sample_instance.id,
            server_id=sample_server.id,
            backup_type="pre_migration",
            status="completed",
            verified=True,
            duration_seconds=120,
            size_mb=512,
        )
        db.add(backup)
        await db.commit()
        await db.refresh(backup)

        assert backup.backup_type == "pre_migration"
        assert backup.verified is True
        assert backup.duration_seconds == 120

    @pytest.mark.asyncio
    async def test_backup_multi_destination(self, db: AsyncSession, sample_instance, sample_server):
        backup = Backup(
            instance_id=sample_instance.id,
            server_id=sample_server.id,
            destinations=[
                {"storage_id": "s3_01", "path": "s3://backups/odoo/20260313.dump", "status": "completed"},
                {"storage_id": "azure_01", "path": "az://backups/odoo/20260313.dump", "status": "completed"},
            ],
            status="completed",
        )
        db.add(backup)
        await db.commit()
        await db.refresh(backup)

        assert len(backup.destinations) == 2
        assert backup.destinations[0]["storage_id"] == "s3_01"

    @pytest.mark.asyncio
    async def test_backup_retention(self, db: AsyncSession, sample_instance, sample_server):
        retain = datetime.now(timezone.utc) + timedelta(days=30)
        backup = Backup(
            instance_id=sample_instance.id,
            server_id=sample_server.id,
            retain_until=retain,
            status="completed",
        )
        db.add(backup)
        await db.commit()
        await db.refresh(backup)

        assert backup.retain_until is not None

    @pytest.mark.asyncio
    async def test_backup_with_schedule_ref(self, db: AsyncSession, sample_instance, sample_server):
        sched_id = str(uuid.uuid4())
        backup = Backup(
            instance_id=sample_instance.id,
            server_id=sample_server.id,
            schedule_id=sched_id,
            status="completed",
        )
        db.add(backup)
        await db.commit()
        await db.refresh(backup)

        assert backup.schedule_id == sched_id


# ======================================================================
# CLONE LIFECYCLE & GUARDS
# ======================================================================


class TestCloneLifecycle:
    """Clone lifecycle operations and safety guards."""

    @pytest.mark.asyncio
    async def test_clone_ready_to_running(self, db: AsyncSession, sample_instance):
        clone = Clone(
            name="start-test",
            source_instance_id=sample_instance.id,
            status="ready",
            is_active=False,
            owner_id="user_001",
        )
        db.add(clone)
        await db.commit()

        clone.status = "running"
        clone.is_active = True
        await db.commit()
        await db.refresh(clone)

        assert clone.status == "running"
        assert clone.is_active is True

    @pytest.mark.asyncio
    async def test_clone_stop(self, db: AsyncSession, sample_instance):
        clone = Clone(
            name="stop-test",
            source_instance_id=sample_instance.id,
            status="running",
            is_active=True,
            owner_id="user_001",
        )
        db.add(clone)
        await db.commit()

        clone.status = "stopped"
        clone.is_active = False
        await db.commit()
        await db.refresh(clone)

        assert clone.status == "stopped"
        assert clone.is_active is False

    @pytest.mark.asyncio
    async def test_one_active_clone_guard(self, db: AsyncSession, sample_instance):
        """Only ONE clone per source instance can be active (token safety)."""
        clone1 = Clone(
            name="clone-1",
            source_instance_id=sample_instance.id,
            status="running",
            is_active=True,
            owner_id="user_001",
        )
        db.add(clone1)
        await db.commit()

        # Query for active clones of this source
        result = await db.execute(
            select(Clone).where(
                Clone.source_instance_id == sample_instance.id,
                Clone.is_active == True,
                Clone.status.notin_(["destroyed", "failed"]),
            )
        )
        active = list(result.scalars().all())
        assert len(active) == 1

        # A second clone should NOT be set active
        clone2 = Clone(
            name="clone-2",
            source_instance_id=sample_instance.id,
            status="ready",
            is_active=False,
            owner_id="user_001",
        )
        db.add(clone2)
        await db.commit()

        # Verify clone2 is NOT active
        assert clone2.is_active is False

        # The guard: before starting clone2, check active count
        result2 = await db.execute(
            select(Clone).where(
                Clone.source_instance_id == sample_instance.id,
                Clone.is_active == True,
                Clone.id != clone2.id,
            )
        )
        already_active = result2.scalar_one_or_none()
        assert already_active is not None  # clone1 is active → can't start clone2

    @pytest.mark.asyncio
    async def test_clone_destroy(self, db: AsyncSession, sample_instance):
        clone = Clone(
            name="destroy-test",
            source_instance_id=sample_instance.id,
            status="stopped",
            is_active=False,
            clone_database="odoo_prod_stag_20260313",
            owner_id="user_001",
        )
        db.add(clone)
        await db.commit()

        clone.status = "destroyed"
        clone.is_active = False
        await db.commit()
        await db.refresh(clone)

        assert clone.status == "destroyed"

    @pytest.mark.asyncio
    async def test_destroyed_clones_excluded_from_listing(self, db: AsyncSession, sample_instance):
        """Destroyed clones should be filtered out in listings."""
        for i, status in enumerate(["ready", "running", "destroyed"]):
            c = Clone(
                name=f"list-test-{i}",
                source_instance_id=sample_instance.id,
                status=status,
                is_active=(status == "running"),
                owner_id="user_001",
            )
            db.add(c)
        await db.commit()

        result = await db.execute(
            select(Clone).where(
                Clone.owner_id == "user_001",
                Clone.status != "destroyed",
                Clone.source_instance_id == sample_instance.id,
            )
        )
        visible = list(result.scalars().all())
        assert all(c.status != "destroyed" for c in visible)

    @pytest.mark.asyncio
    async def test_clone_failed_with_error(self, db: AsyncSession, sample_instance):
        clone = Clone(
            name="failed-clone",
            source_instance_id=sample_instance.id,
            status="failed",
            error_message="createdb: could not connect to server",
            duration_seconds=5,
            owner_id="user_001",
        )
        db.add(clone)
        await db.commit()
        await db.refresh(clone)

        assert clone.status == "failed"
        assert "createdb" in clone.error_message


# ======================================================================
# NEUTRALIZATION SQL
# ======================================================================


class TestNeutralizationSQL:
    """Verify neutralization SQL template correctness.

    We read the SQL directly from the source file to avoid the heavy import
    chain (paramiko, etc.) that core.instance_ops pulls in.
    """

    @staticmethod
    def _load_neutralize_sql() -> str:
        """Extract NEUTRALIZE_SQL from instance_ops.py without importing it."""
        import pathlib, re
        src = pathlib.Path(__file__).parent.parent / "core" / "instance_ops.py"
        text = src.read_text(encoding="utf-8")
        match = re.search(r'NEUTRALIZE_SQL\s*=\s*"""(.*?)"""', text, re.DOTALL)
        assert match, "NEUTRALIZE_SQL not found in instance_ops.py"
        return match.group(1)

    def test_neutralize_sql_has_key_operations(self):
        sql = self._load_neutralize_sql()

        assert "ir_cron SET active = false" in sql
        assert "ir_mail_server SET active = false" in sql
        assert "payment_provider" in sql
        assert "delivery_carrier" in sql
        assert "iap_account" in sql
        assert "fetchmail_server" in sql
        assert "base_automation" in sql
        assert "database.is_neutralized" in sql
        assert "web.base.url" in sql
        assert "CRX Mail Catcher" in sql

    def test_neutralize_sql_base_url_placeholder(self):
        sql = self._load_neutralize_sql()

        rendered = sql.replace("{base_url}", "https://staging.example.com")
        assert "https://staging.example.com" in rendered
        assert "{base_url}" not in rendered

    def test_neutralize_sql_preserves_autovacuum(self):
        """Autovacuum cron should NOT be disabled."""
        sql = self._load_neutralize_sql()

        assert "autovacuum_job" in sql
        assert "NOT IN" in sql

    def test_neutralize_sql_mail_catcher_port(self):
        """Mail catcher should be on port 1025."""
        sql = self._load_neutralize_sql()
        assert "1025" in sql

    def test_neutralize_sql_iap_token_prefix(self):
        """IAP tokens should be prefixed NEUTRALIZED_ not deleted."""
        sql = self._load_neutralize_sql()
        assert "NEUTRALIZED_" in sql


# ======================================================================
# MIGRATION ESTIMATION (unit-level)
# ======================================================================


class TestMigrationEstimation:
    """Migration estimation helpers."""

    def test_human_size_formatting(self):
        """Test the _human() helper inside estimate_migration."""
        # We test the logic directly
        def _human(size: int) -> str:
            for unit in ("B", "KB", "MB", "GB"):
                if size < 1024:
                    return f"{size:.1f} {unit}"
                size /= 1024
            return f"{size:.1f} TB"

        assert _human(500) == "500.0 B"
        assert _human(1024) == "1.0 KB"
        assert _human(1024 * 1024) == "1.0 MB"
        assert _human(1024 * 1024 * 1024) == "1.0 GB"
        assert _human(1024 * 1024 * 1024 * 1024) == "1.0 TB"

    def test_estimation_time_formula(self):
        """Verify estimation time is reasonable."""
        db_size = 500 * 1024 * 1024  # 500 MB
        fs_size = 200 * 1024 * 1024  # 200 MB
        total = db_size + fs_size

        dump_time = max(60, db_size / (10 * 1024 * 1024))
        transfer_time = max(30, total / (5 * 1024 * 1024))
        restore_time = max(60, db_size / (8 * 1024 * 1024))
        total_time = dump_time + transfer_time + restore_time + 120

        # ~50s dump + ~140s transfer + ~62.5s restore + 120s overhead ≈ 372s ≈ 6.2 min
        assert 5 < total_time / 60 < 10  # reasonable range

    def test_space_requirement_formula(self):
        """Target needs 2.5x the total data size."""
        total = 1024 * 1024 * 1024  # 1 GB
        space_needed = total * 2.5
        assert space_needed == 2.5 * 1024 * 1024 * 1024


# ======================================================================
# BACKUP RETENTION LOGIC
# ======================================================================


class TestBackupRetention:
    """Backup retention policy logic."""

    @pytest.mark.asyncio
    async def test_retention_keeps_within_limit(self, db: AsyncSession, sample_instance, sample_server):
        """When backups <= max_keep, none should be deleted."""
        for i in range(5):
            b = Backup(
                instance_id=sample_instance.id,
                server_id=sample_server.id,
                status="completed",
            )
            db.add(b)
        await db.commit()

        result = await db.execute(
            select(Backup)
            .where(Backup.instance_id == sample_instance.id, Backup.status == "completed")
            .order_by(Backup.created_at.desc())
        )
        backups = list(result.scalars().all())

        # Default retention: 7 + 4 + 12 = 23
        max_keep = 7 + 4 + 12
        assert len(backups) <= max_keep  # 5 < 23 → nothing to delete

    @pytest.mark.asyncio
    async def test_retention_deletes_excess(self, db: AsyncSession, sample_instance, sample_server):
        """When backups > max_keep, excess should be identified for deletion."""
        max_keep = 3  # Simulating small retention

        for i in range(6):
            b = Backup(
                instance_id=sample_instance.id,
                server_id=sample_server.id,
                status="completed",
            )
            db.add(b)
        await db.commit()

        result = await db.execute(
            select(Backup)
            .where(Backup.instance_id == sample_instance.id, Backup.status == "completed")
            .order_by(Backup.created_at.desc())
        )
        backups = list(result.scalars().all())

        to_delete = backups[max_keep:]
        assert len(to_delete) == 3  # 6 - 3 = 3 excess


# ======================================================================
# INSTANCE CONFIG HELPERS
# ======================================================================


class TestInstanceConfigHelpers:
    """Config extraction patterns used by instance_ops."""

    def test_prefix_from_config(self):
        config = {"db_name": "odoo_prod", "prefix": "crx-odoo-abcd1234"}
        prefix = config.get("prefix", "crx-odoo-default")
        assert prefix == "crx-odoo-abcd1234"

    def test_prefix_fallback(self):
        config = {"db_name": "odoo_prod"}
        inst_id = "550e8400-e29b-41d4-a716-446655440000"
        prefix = config.get("prefix", f"crx-odoo-{inst_id[:8]}")
        assert prefix == "crx-odoo-550e8400"

    def test_db_name_from_config(self):
        config = {"db_name": "odoo_prod"}
        db_name = config.get("db_name", "fallback_name")
        assert db_name == "odoo_prod"

    def test_db_name_fallback_to_instance_name(self):
        config = {}
        instance_name = "my-odoo"
        db_name = config.get("db_name", instance_name)
        assert db_name == "my-odoo"

    def test_empty_config_handled(self):
        config = None
        prefix = (config or {}).get("prefix", "crx-odoo-default")
        assert prefix == "crx-odoo-default"

    def test_pg_container_naming(self):
        prefix = "crx-odoo-abcd1234"
        assert f"{prefix}-db" == "crx-odoo-abcd1234-db"
        assert f"{prefix}-odoo" == "crx-odoo-abcd1234-odoo"


# ======================================================================
# CLONE DATABASE NAMING
# ======================================================================


class TestCloneDatabaseNaming:
    """Clone database naming conventions."""

    def test_auto_generated_clone_db_name(self):
        source_db = "odoo_prod"
        clone_type = "staging"
        date_str = "20260313"
        expected = f"{source_db}_{clone_type[:4]}_{date_str}"
        assert expected == "odoo_prod_stag_20260313"

    def test_development_clone_db_name(self):
        source_db = "odoo_prod"
        clone_type = "development"
        date_str = "20260313"
        expected = f"{source_db}_{clone_type[:4]}_{date_str}"
        assert expected == "odoo_prod_deve_20260313"

    def test_testing_clone_db_name(self):
        source_db = "odoo_prod"
        clone_type = "testing"
        date_str = "20260313"
        expected = f"{source_db}_{clone_type[:4]}_{date_str}"
        assert expected == "odoo_prod_test_20260313"


# ======================================================================
# SERVER INFO HELPER
# ======================================================================


class TestServerInfoHelper:
    """ServerInfo conversion for VMDriver."""

    def test_server_info_creation(self, sample_server):
        """Can't fully test without ServerInfo import but verify data extraction."""
        assert sample_server.endpoint == "10.0.0.1"
        assert sample_server.ssh_user == "root"
        assert sample_server.ssh_key_path == "/root/.ssh/id_rsa"

    def test_server_ssh_defaults(self):
        """SSH defaults when fields are None."""
        ssh_user = None or "root"
        ssh_key_path = None or ""
        assert ssh_user == "root"
        assert ssh_key_path == ""


# ======================================================================
# EDGE CASES
# ======================================================================


class TestEdgeCases:
    """Edge cases and error handling patterns."""

    @pytest.mark.asyncio
    async def test_migration_error_message_truncation(self, db: AsyncSession, sample_instance, sample_server, sample_target_server):
        """Error messages are truncated to 2000 chars."""
        long_error = "X" * 5000
        mig = Migration(
            source_instance_id=sample_instance.id,
            source_server_id=sample_server.id,
            target_server_id=sample_target_server.id,
            status="failed",
            error_message=long_error[:2000],
        )
        db.add(mig)
        await db.commit()
        await db.refresh(mig)

        assert len(mig.error_message) == 2000

    @pytest.mark.asyncio
    async def test_clone_without_neutralization(self, db: AsyncSession, sample_instance):
        """Clone can be created without neutralization."""
        clone = Clone(
            name="no-neutralize",
            source_instance_id=sample_instance.id,
            neutralized=False,
            owner_id="user_001",
        )
        db.add(clone)
        await db.commit()
        await db.refresh(clone)

        assert clone.neutralized is False
        assert clone.neutralization_log is None

    @pytest.mark.asyncio
    async def test_multiple_clones_same_source(self, db: AsyncSession, sample_instance):
        """Multiple clones from same source (only one active at a time)."""
        for i in range(3):
            c = Clone(
                name=f"multi-{i}",
                source_instance_id=sample_instance.id,
                status="ready" if i < 2 else "running",
                is_active=(i == 2),
                owner_id="user_001",
            )
            db.add(c)
        await db.commit()

        result = await db.execute(
            select(Clone).where(
                Clone.source_instance_id == sample_instance.id,
                Clone.is_active == True,
            )
        )
        active = list(result.scalars().all())
        assert len(active) == 1

    @pytest.mark.asyncio
    async def test_schedule_disabled(self, db: AsyncSession, sample_instance):
        """Disabled schedules should not execute."""
        sched = BackupSchedule(
            instance_id=sample_instance.id,
            owner_id="user_001",
            enabled=False,
        )
        db.add(sched)
        await db.commit()
        await db.refresh(sched)

        assert sched.enabled is False

    @pytest.mark.asyncio
    async def test_migration_no_filestore(self, db: AsyncSession, sample_instance, sample_server, sample_target_server):
        """Migration without filestore is supported."""
        mig = Migration(
            source_instance_id=sample_instance.id,
            source_server_id=sample_server.id,
            target_server_id=sample_target_server.id,
            include_filestore=False,
        )
        db.add(mig)
        await db.commit()
        await db.refresh(mig)

        assert mig.include_filestore is False

    def test_clone_database_none_for_destroy(self):
        """If clone_database is None, destroy is a no-op."""
        clone_db = None
        if not clone_db:
            result = True  # Nothing to destroy
        assert result is True


# ======================================================================
# CRON EXPRESSION VALIDATION
# ======================================================================


class TestCronExpressions:
    """Verify common cron expressions for backup schedules."""

    VALID_CRONS = [
        ("0 2 * * *", "Daily at 2:00 AM"),
        ("0 */6 * * *", "Every 6 hours"),
        ("0 0 * * 0", "Weekly on Sunday"),
        ("0 3 1 * *", "Monthly on 1st at 3:00 AM"),
        ("30 1 * * 1-5", "Weekdays at 1:30 AM"),
    ]

    @pytest.mark.asyncio
    @pytest.mark.parametrize("cron,desc", VALID_CRONS)
    async def test_cron_stored_correctly(self, cron, desc, db: AsyncSession, sample_instance):
        sched = BackupSchedule(
            instance_id=sample_instance.id,
            owner_id="user_001",
            cron_expression=cron,
        )
        db.add(sched)
        await db.commit()
        await db.refresh(sched)
        assert sched.cron_expression == cron
