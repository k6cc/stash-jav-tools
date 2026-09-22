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
    plugin_dir = os.path.dirname(os.path.abspath(__file__))

    # Read input from stdin (passed from the UI)
    input_data = json.loads(sys.stdin.read())

    # Get the plugin directory (script's directory)
    json_file = os.path.join(plugin_dir, 'watch_data.json')

    # Get the mode from args (set by defaultArgs in yml)
    args = input_data.get('args', {})
    mode = args.get('mode', 'save')

    try:
        if mode == 'load':
            # Load data
            if not os.path.exists(json_file):
                print(json.dumps({"output": {}}))
                return

            with open(json_file, 'r', encoding='utf-8') as f:
                watch_data = json.load(f)

            # Migrate to simple format if needed
            watch_data = migrate_to_simple_format(watch_data)

            # Output in the format Stash expects: {"output": data}
            print(json.dumps({"output": watch_data}))
        else:
            # Save data
            watch_data_str = args.get('watch_data')

            if not watch_data_str:
                print(json.dumps(
                    {"error": "No watch data provided"}), file=sys.stderr)
                sys.exit(1)

            # Parse the JSON string to object
            watch_data = json.loads(watch_data_str)

            # Ensure we're saving in simple format
            watch_data = migrate_to_simple_format(watch_data)

            with open(json_file, 'w', encoding='utf-8') as f:
                json.dump(watch_data, f, indent=2)

            # Return success
            print(json.dumps({"output": "success"}))

    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
