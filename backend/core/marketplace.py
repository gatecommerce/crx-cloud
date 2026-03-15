"""Marketplace — persistent JSON index of Odoo modules from multiple GitHub sources.

Architecture (based on industry best practices — Cloudpepper, OCA apps store):
- Index is built ONCE via background task (git clone --depth 1, parse __manifest__.py)
- Stored as JSON file on disk — zero GitHub API calls at browse time
- Refresh via admin endpoint or daily cron
- Supports OCA (258+ repos), Cybrosys, Odoo Mates, Odoo official
"""

from __future__ import annotations

import ast
import asyncio
import json
import logging
import os
import re
import shutil
import tempfile
import time
from dataclasses import dataclass, asdict
from pathlib import Path

from core.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data directory for persistent index
# ---------------------------------------------------------------------------
INDEX_DIR = Path(__file__).resolve().parents[1] / "data" / "marketplace"

# ---------------------------------------------------------------------------
# Multi-source repo catalog
# org, repo, category, source label
# ---------------------------------------------------------------------------
MARKETPLACE_REPOS = [
    # ── OCA (Odoo Community Association) — top repos ─────────────────────
    {"org": "OCA", "repo": "web", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "server-tools", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "server-ux", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "server-auth", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "server-backend", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "server-brand", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "server-env", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "rest-framework", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "queue", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "reporting-engine", "category": "Reporting", "source": "OCA"},
    {"org": "OCA", "repo": "account-financial-tools", "category": "Accounting", "source": "OCA"},
    {"org": "OCA", "repo": "account-financial-reporting", "category": "Accounting", "source": "OCA"},
    {"org": "OCA", "repo": "account-payment", "category": "Accounting", "source": "OCA"},
    {"org": "OCA", "repo": "account-invoicing", "category": "Accounting", "source": "OCA"},
    {"org": "OCA", "repo": "account-reconcile", "category": "Accounting", "source": "OCA"},
    {"org": "OCA", "repo": "account-analytic", "category": "Accounting", "source": "OCA"},
    {"org": "OCA", "repo": "bank-payment", "category": "Accounting", "source": "OCA"},
    {"org": "OCA", "repo": "sale-workflow", "category": "Sales", "source": "OCA"},
    {"org": "OCA", "repo": "sale-reporting", "category": "Sales", "source": "OCA"},
    {"org": "OCA", "repo": "purchase-workflow", "category": "Purchase", "source": "OCA"},
    {"org": "OCA", "repo": "stock-logistics-warehouse", "category": "Inventory", "source": "OCA"},
    {"org": "OCA", "repo": "stock-logistics-workflow", "category": "Inventory", "source": "OCA"},
    {"org": "OCA", "repo": "stock-logistics-barcode", "category": "Inventory", "source": "OCA"},
    {"org": "OCA", "repo": "stock-logistics-reporting", "category": "Inventory", "source": "OCA"},
    {"org": "OCA", "repo": "delivery-carrier", "category": "Inventory", "source": "OCA"},
    {"org": "OCA", "repo": "manufacture", "category": "Manufacturing", "source": "OCA"},
    {"org": "OCA", "repo": "manufacture-reporting", "category": "Manufacturing", "source": "OCA"},
    {"org": "OCA", "repo": "hr", "category": "HR", "source": "OCA"},
    {"org": "OCA", "repo": "hr-attendance", "category": "HR", "source": "OCA"},
    {"org": "OCA", "repo": "hr-expense", "category": "HR", "source": "OCA"},
    {"org": "OCA", "repo": "hr-holidays", "category": "HR", "source": "OCA"},
    {"org": "OCA", "repo": "payroll", "category": "HR", "source": "OCA"},
    {"org": "OCA", "repo": "social", "category": "Communication", "source": "OCA"},
    {"org": "OCA", "repo": "e-commerce", "category": "Website", "source": "OCA"},
    {"org": "OCA", "repo": "website", "category": "Website", "source": "OCA"},
    {"org": "OCA", "repo": "website-cms", "category": "Website", "source": "OCA"},
    {"org": "OCA", "repo": "connector", "category": "Integration", "source": "OCA"},
    {"org": "OCA", "repo": "connector-ecommerce", "category": "Integration", "source": "OCA"},
    {"org": "OCA", "repo": "edi", "category": "Integration", "source": "OCA"},
    {"org": "OCA", "repo": "l10n-italy", "category": "Localization", "source": "OCA"},
    {"org": "OCA", "repo": "l10n-spain", "category": "Localization", "source": "OCA"},
    {"org": "OCA", "repo": "l10n-france", "category": "Localization", "source": "OCA"},
    {"org": "OCA", "repo": "l10n-germany", "category": "Localization", "source": "OCA"},
    {"org": "OCA", "repo": "partner-contact", "category": "CRM", "source": "OCA"},
    {"org": "OCA", "repo": "crm", "category": "CRM", "source": "OCA"},
    {"org": "OCA", "repo": "project", "category": "Project", "source": "OCA"},
    {"org": "OCA", "repo": "project-reporting", "category": "Project", "source": "OCA"},
    {"org": "OCA", "repo": "contract", "category": "Contract", "source": "OCA"},
    {"org": "OCA", "repo": "commission", "category": "Sales", "source": "OCA"},
    {"org": "OCA", "repo": "product-attribute", "category": "Product", "source": "OCA"},
    {"org": "OCA", "repo": "product-variant", "category": "Product", "source": "OCA"},
    {"org": "OCA", "repo": "product-pack", "category": "Product", "source": "OCA"},
    {"org": "OCA", "repo": "pos", "category": "Point of Sale", "source": "OCA"},
    {"org": "OCA", "repo": "mis-builder", "category": "Reporting", "source": "OCA"},
    {"org": "OCA", "repo": "knowledge", "category": "Knowledge", "source": "OCA"},
    {"org": "OCA", "repo": "helpdesk", "category": "Helpdesk", "source": "OCA"},
    {"org": "OCA", "repo": "field-service", "category": "Field Service", "source": "OCA"},
    {"org": "OCA", "repo": "maintenance", "category": "Maintenance", "source": "OCA"},
    {"org": "OCA", "repo": "fleet", "category": "Fleet", "source": "OCA"},
    {"org": "OCA", "repo": "timesheet", "category": "HR", "source": "OCA"},
    {"org": "OCA", "repo": "multi-company", "category": "Multi-Company", "source": "OCA"},
    {"org": "OCA", "repo": "management-system", "category": "Quality", "source": "OCA"},
    {"org": "OCA", "repo": "geospatial", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "community-data-files", "category": "Data", "source": "OCA"},
    {"org": "OCA", "repo": "storage", "category": "Technical", "source": "OCA"},
    {"org": "OCA", "repo": "ddmrp", "category": "Manufacturing", "source": "OCA"},
    {"org": "OCA", "repo": "wms", "category": "Inventory", "source": "OCA"},
    {"org": "OCA", "repo": "vertical-association", "category": "Association", "source": "OCA"},
    {"org": "OCA", "repo": "data-protection", "category": "GDPR", "source": "OCA"},
    {"org": "OCA", "repo": "dms", "category": "Document", "source": "OCA"},
    {"org": "OCA", "repo": "brand", "category": "Product", "source": "OCA"},
    {"org": "OCA", "repo": "operating-unit", "category": "Multi-Company", "source": "OCA"},
    # ── Cybrosys ─────────────────────────────────────────────────────────
    {"org": "CybroOdoo", "repo": "CybroAddons", "category": "Apps", "source": "Cybrosys"},
    {"org": "CybroOdoo", "repo": "OpenHRMS", "category": "HR", "source": "Cybrosys"},
    # ── Odoo Mates ───────────────────────────────────────────────────────
    {"org": "odoomates", "repo": "odooapps", "category": "Apps", "source": "Odoo Mates"},
    # ── Odoo official ────────────────────────────────────────────────────
    {"org": "odoo", "repo": "design-themes", "category": "Themes", "source": "Odoo"},
]

SOURCES = ["OCA", "Cybrosys", "Odoo Mates", "Odoo"]


@dataclass
class ModuleInfo:
    technical_name: str
    display_name: str
    summary: str
    version: str
    author: str
    license: str
    category: str
    depends: list[str]
    installable: bool
    repo_name: str
    repo_url: str
    repo_category: str
    source: str = "OCA"
    icon_url: str = ""


def _parse_manifest(raw: str) -> dict | None:
    """Parse __manifest__.py content (Python dict literal)."""
    try:
        cleaned = re.sub(r'\b_\(\s*(["\'])', r'\1', raw)
        cleaned = re.sub(r'(["\'])\s*\)', r'\1', cleaned)
        return ast.literal_eval(cleaned)
    except Exception:
        try:
            return ast.literal_eval(raw)
        except Exception:
            return None


def _index_path(branch: str) -> Path:
    return INDEX_DIR / f"index_{branch}.json"


async def _clone_and_index_repo(
    org: str, repo: str, branch: str, category: str, source: str, tmp_base: str
) -> list[dict]:
    """Shallow-clone a single repo and extract all module manifests."""
    url = f"https://github.com/{org}/{repo}.git"
    clone_dir = os.path.join(tmp_base, f"{org}__{repo}")
    modules = []

    try:
        proc = await asyncio.create_subprocess_exec(
            "git", "clone", "--depth", "1", "--branch", branch,
            "--single-branch", "--quiet", url, clone_dir,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        # CybroAddons/OpenHRMS are huge repos — need more time
        timeout = 300 if "cybro" in repo.lower() or "hrms" in repo.lower() else 120
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        if proc.returncode != 0:
            err = stderr.decode(errors="replace").strip()
            if "not found" in err.lower() or "could not find" in err.lower():
                return []  # branch doesn't exist for this repo
            logger.warning(f"Clone failed {org}/{repo}@{branch}: {err[:200]}")
            return []

        # Walk directories looking for __manifest__.py
        repo_path = Path(clone_dir)
        for manifest_file in repo_path.glob("*/__manifest__.py"):
            mod_dir = manifest_file.parent
            mod_name = mod_dir.name
            if mod_name.startswith("."):
                continue

            try:
                raw = manifest_file.read_text(encoding="utf-8", errors="replace")
                manifest = _parse_manifest(raw)
            except Exception:
                manifest = None

            if manifest and not manifest.get("installable", True):
                continue

            icon_url = f"https://raw.githubusercontent.com/{org}/{repo}/{branch}/{mod_name}/static/description/icon.png"

            if manifest:
                modules.append({
                    "technical_name": mod_name,
                    "display_name": manifest.get("name", mod_name.replace("_", " ").title()),
                    "summary": (manifest.get("summary", "") or manifest.get("description", "") or "")[:200],
                    "version": manifest.get("version", ""),
                    "author": manifest.get("author", source),
                    "license": manifest.get("license", "LGPL-3"),
                    "category": manifest.get("category", category),
                    "depends": manifest.get("depends", []),
                    "installable": True,
                    "repo_name": repo,
                    "repo_url": f"https://github.com/{org}/{repo}.git",
                    "repo_category": category,
                    "source": source,
                    "icon_url": icon_url,
                })
            else:
                modules.append({
                    "technical_name": mod_name,
                    "display_name": mod_name.replace("_", " ").title(),
                    "summary": "",
                    "version": "",
                    "author": source,
                    "license": "LGPL-3",
                    "category": category,
                    "depends": [],
                    "installable": True,
                    "repo_name": repo,
                    "repo_url": f"https://github.com/{org}/{repo}.git",
                    "repo_category": category,
                    "source": source,
                    "icon_url": "",
                })

    except asyncio.TimeoutError:
        logger.warning(f"Clone timeout for {org}/{repo}@{branch}")
    except Exception as e:
        logger.warning(f"Error indexing {org}/{repo}@{branch}: {e}")
    finally:
        # Cleanup clone dir
        shutil.rmtree(clone_dir, ignore_errors=True)

    return modules


async def build_index_for_branch(branch: str) -> dict:
    """Build complete marketplace index via shallow git clones. No API rate limits."""
    logger.info(f"Building marketplace index for {branch} via git clone ({len(MARKETPLACE_REPOS)} repos)...")
    start = time.time()

    INDEX_DIR.mkdir(parents=True, exist_ok=True)
    tmp_base = tempfile.mkdtemp(prefix="crx_mp_")

    try:
        # Clone repos in batches of 5 concurrently
        all_modules: list[dict] = []
        batch_size = 5
        for i in range(0, len(MARKETPLACE_REPOS), batch_size):
            batch = MARKETPLACE_REPOS[i:i + batch_size]
            tasks = [
                _clone_and_index_repo(r["org"], r["repo"], branch, r["category"], r["source"], tmp_base)
                for r in batch
            ]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            for result in results:
                if isinstance(result, list):
                    all_modules.extend(result)
                elif isinstance(result, Exception):
                    logger.warning(f"Batch error: {result}")

            progress = min(i + batch_size, len(MARKETPLACE_REPOS))
            logger.info(f"  Indexed {progress}/{len(MARKETPLACE_REPOS)} repos, {len(all_modules)} modules so far...")

        # Deduplicate by technical_name (first occurrence wins)
        seen = set()
        unique_modules = []
        for m in all_modules:
            if m["technical_name"] not in seen:
                seen.add(m["technical_name"])
                unique_modules.append(m)

        unique_modules.sort(key=lambda m: m["display_name"].lower())

        # Build index data
        categories = sorted(set(m["repo_category"] for m in unique_modules))
        sources = sorted(set(m["source"] for m in unique_modules))

        index_data = {
            "branch": branch,
            "built_at": time.time(),
            "built_at_iso": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "total_modules": len(unique_modules),
            "total_repos": len(MARKETPLACE_REPOS),
            "categories": categories,
            "sources": sources,
            "modules": unique_modules,
        }

        # Save to disk
        index_file = _index_path(branch)
        index_file.write_text(json.dumps(index_data, ensure_ascii=False), encoding="utf-8")

        elapsed = time.time() - start
        logger.info(
            f"Marketplace index built: {len(unique_modules)} modules for {branch} "
            f"in {elapsed:.1f}s — saved to {index_file}"
        )
        return index_data

    finally:
        shutil.rmtree(tmp_base, ignore_errors=True)


class MarketplaceService:
    """Serves marketplace modules from a persistent JSON index file."""

    def __init__(self):
        self._cache: dict[str, dict] = {}  # branch -> index_data
        self._building: set[str] = set()   # branches currently being built

    def _load_from_disk(self, branch: str) -> dict | None:
        """Load index from JSON file if it exists."""
        index_file = _index_path(branch)
        if index_file.exists():
            try:
                data = json.loads(index_file.read_text(encoding="utf-8"))
                self._cache[branch] = data
                logger.info(
                    f"Loaded marketplace index from disk: {data.get('total_modules', 0)} modules "
                    f"for {branch} (built {data.get('built_at_iso', 'unknown')})"
                )
                return data
            except Exception as e:
                logger.error(f"Failed to load marketplace index: {e}")
        return None

    def get_index(self, branch: str) -> dict | None:
        """Get cached index, or load from disk."""
        if branch in self._cache:
            return self._cache[branch]
        return self._load_from_disk(branch)

    def is_building(self, branch: str) -> bool:
        return branch in self._building

    async def ensure_index(self, branch: str) -> dict:
        """Get index, building it if necessary."""
        idx = self.get_index(branch)
        if idx:
            return idx

        # Need to build — but don't block if already building
        if branch in self._building:
            return {"modules": [], "total_modules": 0, "categories": [], "sources": [], "building": True}

        self._building.add(branch)
        try:
            idx = await build_index_for_branch(branch)
            self._cache[branch] = idx
            return idx
        finally:
            self._building.discard(branch)

    async def rebuild_index(self, branch: str) -> dict:
        """Force rebuild the index."""
        self._cache.pop(branch, None)
        self._building.add(branch)
        try:
            idx = await build_index_for_branch(branch)
            self._cache[branch] = idx
            return idx
        finally:
            self._building.discard(branch)

    async def search_modules(
        self,
        branch: str,
        search: str = "",
        category: str = "",
        source: str = "",
        page: int = 1,
        per_page: int = 24,
        user_token: str | None = None,
    ) -> dict:
        """Search and paginate marketplace modules from persistent index."""
        index_data = self.get_index(branch)

        if not index_data:
            # No index yet — return empty with building flag
            if branch not in self._building:
                # Trigger background build
                asyncio.create_task(self._bg_build(branch))
            return {
                "modules": [],
                "total": 0,
                "page": 1,
                "per_page": per_page,
                "total_pages": 0,
                "categories": [],
                "sources": SOURCES,
                "building": True,
            }

        all_modules = index_data.get("modules", [])

        # Filter
        filtered = all_modules
        if source:
            src_lower = source.lower()
            filtered = [m for m in filtered if m.get("source", "").lower() == src_lower]
        if category:
            cat_lower = category.lower()
            filtered = [
                m for m in filtered
                if m.get("repo_category", "").lower() == cat_lower
                or m.get("category", "").lower() == cat_lower
            ]
        if search:
            q = search.lower()
            filtered = [
                m for m in filtered
                if q in m.get("technical_name", "").lower()
                or q in m.get("display_name", "").lower()
                or q in m.get("summary", "").lower()
                or q in m.get("author", "").lower()
            ]

        total = len(filtered)
        start = (page - 1) * per_page
        page_modules = filtered[start:start + per_page]

        return {
            "modules": page_modules,
            "total": total,
            "page": page,
            "per_page": per_page,
            "total_pages": max(1, (total + per_page - 1) // per_page),
            "categories": index_data.get("categories", []),
            "sources": index_data.get("sources", SOURCES),
            "building": False,
        }

    async def _bg_build(self, branch: str):
        """Background index build."""
        if branch in self._building:
            return
        self._building.add(branch)
        try:
            idx = await build_index_for_branch(branch)
            self._cache[branch] = idx
        except Exception as e:
            logger.error(f"Background index build failed for {branch}: {e}")
        finally:
            self._building.discard(branch)


# Singleton
marketplace_service = MarketplaceService()
