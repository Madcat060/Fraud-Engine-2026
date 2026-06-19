import json
import os
import uuid


def _generate_id():
    return str(uuid.uuid4())[:8]


class Storage:
    def __init__(self, data_dir=None):
        if data_dir is None:
            data_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
        self.data_dir = data_dir
        self.data_file = os.path.join(data_dir, 'app_data.json')
        self._ensure_data_file()

    def _ensure_data_file(self):
        os.makedirs(self.data_dir, exist_ok=True)
        if not os.path.exists(self.data_file):
            self._save({
                'profiles': {}, 'report_lists': {}, 'reports': {},
                'settings': {'default_db_connection_string': ''}
            })
        else:
            data = self._load()
            if 'settings' not in data:
                data['settings'] = {'default_db_connection_string': ''}
                self._save(data)

    def _load(self):
        with open(self.data_file, 'r') as f:
            return json.load(f)

    def _save(self, data):
        with open(self.data_file, 'w') as f:
            json.dump(data, f, indent=2)

    def get_profiles(self):
        data = self._load()
        return list(data['profiles'].values())

    def create_profile(self, name, username, password):
        data = self._load()
        for p in data['profiles'].values():
            if p['name'].lower() == name.lower():
                return None
        profile_id = _generate_id()
        profile = {
            'id': profile_id,
            'name': name,
            'username': username,
            'password': password
        }
        data['profiles'][profile_id] = profile
        self._save(data)
        return profile

    def update_profile(self, profile_id, updates):
        data = self._load()
        if profile_id not in data['profiles']:
            return 'not_found'
        profile = data['profiles'][profile_id]
        if 'name' in updates:
            new_name = updates['name'].strip()
            if not new_name:
                return 'invalid'
            for p in data['profiles'].values():
                if p['id'] != profile_id and p['name'].lower() == new_name.lower():
                    return 'duplicate'
            profile['name'] = new_name
        if 'username' in updates and not updates['username'].strip():
            return 'invalid'
        if 'username' in updates:
            profile['username'] = updates['username'].strip()
        if 'password' in updates:
            profile['password'] = updates['password']
        self._save(data)
        return profile

    def delete_profile(self, profile_id):
        data = self._load()
        if profile_id not in data['profiles']:
            return False
        del data['profiles'][profile_id]
        lists_to_delete = [lid for lid, l in data['report_lists'].items() if l['profile_id'] == profile_id]
        for lid in lists_to_delete:
            reports_to_delete = [rid for rid, r in data['reports'].items() if r['list_id'] == lid]
            for rid in reports_to_delete:
                del data['reports'][rid]
            del data['report_lists'][lid]
        self._save(data)
        return True

    def get_report_lists(self, profile_id):
        data = self._load()
        return [l for l in data['report_lists'].values() if l['profile_id'] == profile_id]

    def create_report_list(self, profile_id, name):
        data = self._load()
        if profile_id not in data['profiles']:
            return None
        for l in data['report_lists'].values():
            if l['profile_id'] == profile_id and l['name'].lower() == name.lower():
                return None
        list_id = _generate_id()
        report_list = {
            'id': list_id,
            'profile_id': profile_id,
            'name': name
        }
        data['report_lists'][list_id] = report_list
        self._save(data)
        return report_list

    def update_report_list(self, list_id, updates):
        data = self._load()
        if list_id not in data['report_lists']:
            return 'not_found'
        report_list = data['report_lists'][list_id]
        if 'name' in updates:
            new_name = updates['name'].strip()
            if not new_name:
                return 'invalid'
            for l in data['report_lists'].values():
                if l['id'] != list_id and l['profile_id'] == report_list['profile_id'] and l['name'].lower() == new_name.lower():
                    return 'duplicate'
            report_list['name'] = new_name
        self._save(data)
        return report_list

    def delete_report_list(self, list_id):
        data = self._load()
        if list_id not in data['report_lists']:
            return False
        reports_to_delete = [rid for rid, r in data['reports'].items() if r['list_id'] == list_id]
        for rid in reports_to_delete:
            del data['reports'][rid]
        del data['report_lists'][list_id]
        self._save(data)
        return True

    def get_reports(self, list_id):
        data = self._load()
        reports = [r for r in data['reports'].values() if r['list_id'] == list_id]
        reports.sort(key=lambda r: r.get('order', 0))
        return reports

    def get_report(self, report_id):
        data = self._load()
        return data['reports'].get(report_id)

    def get_report_list(self, list_id):
        data = self._load()
        return data['report_lists'].get(list_id)

    def get_all_reports_with_schedules(self):
        """Returns all reports that have schedule_enabled=True and active=True (or truthy)."""
        data = self._load()

        def is_schedule_enabled(r):
            v = r.get('schedule_enabled')
            return v is True or (isinstance(v, str) and v.lower() == 'true') or v == 1

        def is_active(r):
            v = r.get('active', True)
            return v is True or (isinstance(v, str) and v.lower() == 'true') or v == 1

        return [r for r in data['reports'].values() if is_schedule_enabled(r) and is_active(r)]

    def create_report(self, list_id, report_data):
        data = self._load()
        if list_id not in data['report_lists']:
            return None
        report_id = _generate_id()
        existing = [r for r in data['reports'].values() if r['list_id'] == list_id]
        order = max((r.get('order', 0) for r in existing), default=-1) + 1
        report = {
            'id': report_id,
            'list_id': list_id,
            'order': order,
            'active': report_data.get('active', True),
            'api_curl': report_data.get('api_curl', ''),
            'filename': report_data.get('filename', ''),
            'save_to': report_data.get('save_to', ''),
            'days': report_data.get('days', ''),
            'recurrence': report_data.get('recurrence', ''),
            'output_mode': report_data.get('output_mode', 'csv'),
            'db_table_name': report_data.get('db_table_name', ''),
            'db_connection_string': report_data.get('db_connection_string', ''),
            'date_format': report_data.get('date_format', ''),
            'api_timezone': report_data.get('api_timezone', 'GMT'),
            'player_params': report_data.get('player_params', {}),
            'nickname': report_data.get('nickname', ''),
            'username': report_data.get('username', ''),
            'player_code': report_data.get('player_code', ''),
            'schedule_enabled': report_data.get('schedule_enabled', False),
            'schedule_start': report_data.get('schedule_start', ''),
            'schedule_end': report_data.get('schedule_end', ''),
            'schedule_interval_value': report_data.get('schedule_interval_value', 5),
            'schedule_interval_unit': report_data.get('schedule_interval_unit', 'minutes')
        }
        data['reports'][report_id] = report
        self._save(data)
        return report

    def update_report(self, report_id, updates):
        data = self._load()
        if report_id not in data['reports']:
            return None
        report = data['reports'][report_id]
        allowed_fields = ['active', 'api_curl', 'filename', 'save_to', 'days', 'recurrence',
                          'output_mode', 'db_table_name', 'db_connection_string', 'order',
                          'date_format', 'api_timezone', 'player_params', 'nickname', 'username', 'player_code',
                          'schedule_enabled', 'schedule_start', 'schedule_end',
                          'schedule_interval_value', 'schedule_interval_unit']
        for field in allowed_fields:
            if field in updates:
                report[field] = updates[field]
        self._save(data)
        return report

    def delete_report(self, report_id):
        data = self._load()
        if report_id not in data['reports']:
            return False
        del data['reports'][report_id]
        self._save(data)
        return True

    def get_settings(self):
        data = self._load()
        s = data.get('settings', {'default_db_connection_string': ''})
        # Feature flags (defaults: off)
        if 'ews_clickup_theme' not in s:
            s = dict(s)
            s['ews_clickup_theme'] = True
        return s

    def update_settings(self, updates):
        data = self._load()
        settings = data.get('settings', {'default_db_connection_string': ''})
        if not isinstance(settings, dict):
            settings = {'default_db_connection_string': ''}
        settings = dict(settings)
        if 'default_db_connection_string' in updates:
            settings['default_db_connection_string'] = updates['default_db_connection_string']
        if 'ews_clickup_theme' in updates:
            v = updates['ews_clickup_theme']
            settings['ews_clickup_theme'] = v is True or (isinstance(v, str) and v.lower() in ('on', 'true', '1'))
        data['settings'] = settings
        self._save(data)
        return settings

