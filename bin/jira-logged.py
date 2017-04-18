#!/usr/bin/env python3

import requests
import arrow

import argparse
from collections import defaultdict
import getpass
import subprocess
import sys
from datetime import timedelta

class Jira:
    def __init__(self, jira_root, user, password):
        self.user = user
        self.jira_root = jira_root
        self.session = requests.Session()
        self.session.auth = (user, password)
        self.api_root = jira_root + "/rest/api/latest"

    def _get(self, path, params=None):
        response = self.session.get(self.api_root + path, params=params)
        response.raise_for_status()
        return response.json()

    def _get_issues_worked_on(self, since_days_ago):
        response = self._get("/search/", params={
            'jql': 'worklogAuthor = currentUser() AND worklogDate > startOfDay(-{}d)'.format(since_days_ago),
            'validateQuery': 'strict',
            'fields': 'worklog,key',
            'expand': '',
        })

        issues = response['issues']
        assert len(issues) >= response['total'], "need to paginate issues"
        return issues

    def _get_worklogs_since(self, since_days_ago):
        jiras = defaultdict(lambda: defaultdict(list))

        for issue in self._get_issues_worked_on(since_days_ago):
            worklogs = issue['fields']['worklog']['worklogs']
            if len(issue['fields']['worklog']['worklogs']) < issue['fields']['worklog']['total']:
                worklog_response = self._get("/issue/" + issue['key'] + '/worklog')
                worklogs = worklog_response['worklogs']
                assert len(worklogs) >= worklog_response['total'], "need to paginate worklogs"

            for worklog in worklogs:
                if worklog['author']['emailAddress'] == self.user or worklog['author']['key'] == self.user:
                    time = arrow.get(worklog['started'])
                    if time + timedelta(days=since_days_ago) < arrow.now():
                        continue
                    jiras[time.date()][issue['key']].append(worklog)
        return jiras

    def print_work_logged(self, since_days_ago):
        jiras = self._get_worklogs_since(since_days_ago)

        for date, key_logs in sorted(jiras.items()):
            total_spent = timedelta(seconds=sum(log['timeSpentSeconds'] for logs in key_logs.values() for log in logs))
            print("{}: {}".format(date, total_spent))
            for issue_key, worklogs in sorted(key_logs.items()):
                timespent = timedelta(seconds=sum(log['timeSpentSeconds'] for log in worklogs))
                print(" - {}: {}".format(issue_key, timespent))
                print('   {}/browse/{}'.format(self.jira_root, issue_key))

def main():
    parser = argparse.ArgumentParser(description="Tool for finding logged time in jira")
    parser.add_argument("jira_root", help="Root URL for your jira instance")
    parser.add_argument("days", help="Number of days in the past to query", type=int)
    parser.add_argument("--lpass_name", help="Name used when querying lpass cli tool", default="atlassian.net")
    args = parser.parse_args()

    password = subprocess.check_output(["lpass", "show", "--password", args.lpass_name])[:-1].decode()
    user = subprocess.check_output(["lpass", "show", "--username", args.lpass_name])[:-1].decode()

    jira = Jira(args.jira_root, user, password)
    jira.print_work_logged(args.days)

if __name__ == '__main__':
    main()
