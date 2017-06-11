from __future__ import unicode_literals, division, absolute_import
from builtins import *  # noqa pylint: disable=unused-import, redefined-builtin
from future.utils import PY3
import youtube_dl

import logging
import csv

from flexget import plugin
from flexget.config_schema import one_or_more
from flexget.entry import Entry
from flexget.event import event
from flexget.utils.cached_input import cached

log = logging.getLogger('youtube')

class InputYoutube(object):
    """
        Adds support for youtube URI list format.
        Configuration format:
        youtube:
          - http://youtube.com/<xyz>
    """

    schema = one_or_more({
        'type': 'string'
    })

    def on_task_input(self, task, config):
        yt_config = {
            'logger': log,
            'ignoreerrors': True,
            'extract_flat': 'in_playlist',
        }
        with youtube_dl.YoutubeDL(yt_config) as yt:
            entries = []
            for url in config:
                info = yt.extract_info(url, download=False)
                if 'entries' in info:
                    items = info['entries']
                else:
                    items = [info]

                for item in items:
                    if not item:
                        continue
                    item['url'] = item.get('url', item.get('webpage_url'))
                    if not item['url']:
                        continue
                    entries.append(Entry(**item))
            return entries


class DownloadYoutube(object):
    schema = {
        'type': 'object',
        'properties': {
            'add_metadata': {'type': 'boolean', 'default': True},
            # TODO: add an 'output' with proper jinja, etc.
            'outtmpl': {'type': 'string'},
            'format': {'type': 'string'},
        },
        'additionalProperties': True
    }

    def on_task_download(self, task, config):
        config['logger'] = log
        with youtube_dl.YoutubeDL(config) as yt:
            for entry in task.accepted:
                try:
                    yt.process_ie_result(entry, download=True)
                    entry.complete()
                except Exception, e:
                    entry.fail(str(e))

    def on_task_output(self, task, config):
        # makes this plugin count as output (stops warnings about missing outputs)
        pass


@event('plugin.register')
def register_plugin():
    plugin.register(InputYoutube, 'youtube', api_ver=2)
    plugin.register(DownloadYoutube, 'download_youtube', api_ver=2)
