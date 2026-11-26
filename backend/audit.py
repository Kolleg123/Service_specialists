"""Atomic audit log helpers."""
import json


def audit(connection, actor_id, action, object_type, object_id, old_state=None, new_state=None, reason=None):
    def safe(value):
        if value is None:
            return None
        if isinstance(value, str):
            return value
        return json.dumps(value, ensure_ascii=False, sort_keys=True)
    connection.execute(
        """INSERT INTO audit_log(actor_id,action,object_type,object_id,old_state,new_state,reason,created_at)
           VALUES(?,?,?,?,?,?,?,datetime('now'))""",
        (actor_id, action, object_type, object_id, safe(old_state), safe(new_state), reason)
    )
