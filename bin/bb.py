#!/usr/bin/env python3

import getpass
import pdb
from urllib.parse import urljoin
import argparse
import subprocess
import re

import requests
import arrow


class Activity:
    def __init__(self, data):
        self.pull_request = data.pop('pull_request')
        self.type = list(data.keys())[0]
        self.data = data[self.type]
        self.event_time = arrow.get(self.data.get('date', self.data.get('created_on')))


class API:
    def __init__(self, username, password, repo):
        self.username = username
        self.repo = repo
        self.session = requests.Session()
        self.session.auth = (username, password)
        self.base = "https://api.bitbucket.org/2.0/"

    def _get(self, path, params=None):
        resp = self.session.get(urljoin(self.base, path), params=params)
        resp.raise_for_status()
        return resp.json()

    def activity(self):
        resp = self._get("repositories/{0}/pullrequests/activity".format(self.repo), params={'pagelen': 50})
        while resp['values']:
            for act in resp['values']:
                yield Activity(act)
            if not resp['next']:
                break
            resp = self._get(resp['next'])

    def merged(self, since):
        for act in self.activity():
            if act.type == 'update' and act.data['state'] == 'MERGED':
                if act.event_time < since:
                    break
                print(act.pull_request['id'], act.event_time.humanize())

    def comments(self, since, jira_root=None):
        prs = {}
        def add_act(act, text):
            pr_data = prs.setdefault(act.pull_request['id'], {
                'pr': act.pull_request,
                'actions': []
            })
            pr_data['actions'].append(text)

        for act in self.activity():
            if act.event_time < since:
                break

            if act.type == 'update':
                pass
            elif act.type in {'comment', 'approval'}:
                if act.data['user']['username'] == self.username:
                    add_act(act, "{0} {1}".format(act.type, act.event_time.humanize()))
            else:
                raise Exception('unknown type ' + key)

        for pr in prs.values():
            print('#{id}: {title}'.format(**pr['pr']))
            match = re.match(r"([a-zA-Z]+-[0-9]+).*", pr['pr']['title'])
            print('  {}'.format(pr['pr']['links']['html']['href']))
            if match and jira_root:
                print('  {}/browse/{}'.format(jira_root, match.group(1)))
            for act in pr['actions']:
                print('  -', act)


def main():
    parser = argparse.ArgumentParser(description="bitbucket tool")
    parser.add_argument("action", choices=("merged", "comments"))
    parser.add_argument("username")
    parser.add_argument("repository")
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--lpass-name")
    parser.add_argument("--days", type=int, default=1)
    parser.add_argument("--jira-root")
    args = parser.parse_args()

    try:
        if args.lpass_name:
            password = subprocess.check_output(["lpass", "show", "--password", args.lpass_name])[:-1]
        else:
            password = getpass.getpass("Password for {}@{}: ".format(args.username, args.repository))

        api = API(args.username, password, args.repository)

        start = arrow.now().replace(days=-args.days)
        if args.action == 'merged':
            api.merged(start)
        elif args.action == 'comments':
            api.comments(start, args.jira_root)

    except:
        if args.debug:
            pdb.post_mortem()
        raise


if __name__ == '__main__':
    main()
