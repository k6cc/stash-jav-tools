import json
import sys
import os


def migrate_to_simple_format(watch_data):
    """Migrate from old format (with videos array) to new format (just totals)"""
    # Check if this is an export format with wrapper
    if isinstance(watch_data, dict) and 'data' in watch_data and 'version' in watch_data:
        # Extract the actual data from the export format
        watch_data = watch_data['data']

    migrated = {}
    for date, data in watch_data.items():
        if isinstance(data, dict) and 'totalTime' in data:
            # Old format with videos - extract just the total time
            migrated[date] = data['totalTime']
        elif isinstance(data, (int, float)):
            # Already in simple format
            migrated[date] = data
        else:
            # Unknown format, skip
            pass
    return migrated


def main():
    # Get the plugin directory (script's directory)
    plugin_dir = os.path.dirname(os.path.abspath(__file__))
    json_file = os.path.join(plugin_dir, 'watch_data.json')

    try:
        # Check if file exists
        if not os.path.exists(json_file):
            print(json.dumps({"output": {}}))
            return

        # Read the watch data from JSON file
        with open(json_file, 'r', encoding='utf-8') as f:
            watch_data = json.load(f)

        # Migrate to simple format if needed
        watch_data = migrate_to_simple_format(watch_data)

        print(json.dumps({"output": watch_data}))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
