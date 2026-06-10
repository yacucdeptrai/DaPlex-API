import { Controller, Get, Post, Body, Patch, Param, Query, Delete, UseGuards, HttpCode } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
  ApiUnauthorizedResponse
} from '@nestjs/swagger';

import { MediaChaptersService } from './media-chapters.service';
import { AddMediaChapterDto, DeleteMediaChaptersDto, UpdateMediaChapterDto } from './dto';
import { AuthUserDto } from '../users';
import { Media, MediaChapter, MediaVideo } from './entities';
import { AuthGuard } from '../auth/guards/auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ErrorMessage } from '../auth';
import { HeadersDto } from '../../common/dto';
import { ParseBigIntPipe } from '../../common/pipes';
import { AuthGuardOptions } from '../../decorators/auth-guard-options.decorator';
import { AuthUser } from '../../decorators/auth-user.decorator';
import { RolesGuardOptions } from '../../decorators/roles-guard-options.decorator';
import { RequestHeaders } from '../../decorators/request-headers.decorator';
import { UserPermission } from '../../enums';

@ApiTags('Media')
@ApiExtraModels(Media)
@Controller()
export class MediaChapterController {
  constructor(private readonly mediaChaptersService: MediaChaptersService) {}

  @Post(':id/movie/chapters')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Add a chapter to an existing movie (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiCreatedResponse({ description: 'Return added chapters', type: [MediaChapter] })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  addMovieChapter(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() addMediaChapterDto: AddMediaChapterDto
  ) {
    return this.mediaChaptersService.addMovieChapter(id, addMediaChapterDto, headers, authUser);
  }

  @Get(':id/movie/chapters')
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({
    summary: `Find all chapters in a movie, (optional auth, optional permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiOkResponse({ description: 'Return a list of chapters', type: [MediaChapter] })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'The media is private', type: ErrorMessage })
  findAllMovieChapters(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaChaptersService.findAllMovieChapters(id, headers, authUser);
  }

  @Patch(':id/movie/chapters/:chapter_id')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'chapter_id', type: String })
  @ApiOperation({ summary: `Update a chapter (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiCreatedResponse({ description: 'Return updated chapters', type: [MediaVideo] })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media (or the chapter) could not be found', type: ErrorMessage })
  updateMovieChapter(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('chapter_id', ParseBigIntPipe) chapterId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() updateMediaChapterDto: UpdateMediaChapterDto
  ) {
    return this.mediaChaptersService.updateMovieChapter(id, chapterId, updateMediaChapterDto, headers, authUser);
  }

  @Delete(':id/movie/chapters/:chapter_id')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'chapter_id', type: String })
  @ApiOperation({ summary: `Delete a chapter by id (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Chapter has been deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media (or the chapter) could not be found', type: ErrorMessage })
  deleteMovieChapter(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('chapter_id', ParseBigIntPipe) chapterId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaChaptersService.deleteMovieChapter(id, chapterId, headers, authUser);
  }

  @Delete(':id/movie/chapters')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiOperation({ summary: `Delete multiple chapters (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Chapters have been deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The media could not be found', type: ErrorMessage })
  deleteMovieChapters(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Query() deleteMediaChaptersDto: DeleteMediaChaptersDto
  ) {
    return this.mediaChaptersService.deleteMovieChapters(id, deleteMediaChaptersDto, headers, authUser);
  }

  @Post(':id/tv/episodes/:episode_id/chapters')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({ summary: `Add a chapter to an existing episode (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiCreatedResponse({ description: 'Return added chapters', type: [MediaChapter] })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The episode could not be found', type: ErrorMessage })
  addTVEpisodeChapter(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() addMediaChapterDto: AddMediaChapterDto
  ) {
    return this.mediaChaptersService.addTVEpisodeChapter(id, episodeId, addMediaChapterDto, headers, authUser);
  }

  @Get(':id/tv/episodes/:episode_id/chapters')
  @UseGuards(AuthGuard, RolesGuard)
  @AuthGuardOptions({ anonymous: true })
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA], optional: true })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({
    summary: `Find all chapters in an episode, (optional auth, optional permissions: ${UserPermission.MANAGE_MEDIA})`
  })
  @ApiOkResponse({ description: 'Return a list of chapters', type: [MediaChapter] })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The episode could not be found', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'The episode is private', type: ErrorMessage })
  findAllTVEpisodeChapters(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaChaptersService.findAllTVEpisodeChapters(id, episodeId, headers, authUser);
  }

  @Patch(':id/tv/episodes/:episode_id/chapters/:chapter_id')
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiParam({ name: 'chapter_id', type: String })
  @ApiOperation({ summary: `Update a chapter (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiCreatedResponse({ description: 'Return updated chapters', type: [MediaVideo] })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The episode (or the chapter) could not be found', type: ErrorMessage })
  updateTVEpisodeChapter(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @Param('chapter_id', ParseBigIntPipe) chapterId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Body() updateMediaChapterDto: UpdateMediaChapterDto
  ) {
    return this.mediaChaptersService.updateTVEpisodeChapter(
      id,
      episodeId,
      chapterId,
      updateMediaChapterDto,
      headers,
      authUser
    );
  }

  @Delete(':id/tv/episodes/:episode_id/chapters/:chapter_id')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiParam({ name: 'chapter_id', type: String })
  @ApiOperation({ summary: `Delete a chapter by id (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Chapter has been deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The episode (or the chapter) could not be found', type: ErrorMessage })
  deleteTVEpisodeChapter(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @Param('chapter_id', ParseBigIntPipe) chapterId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto
  ) {
    return this.mediaChaptersService.deleteTVEpisodeChapter(id, episodeId, chapterId, headers, authUser);
  }

  @Delete(':id/tv/episodes/:episode_id/chapters')
  @HttpCode(204)
  @UseGuards(AuthGuard, RolesGuard)
  @RolesGuardOptions({ permissions: [UserPermission.MANAGE_MEDIA] })
  @ApiBearerAuth()
  @ApiParam({ name: 'id', type: String })
  @ApiParam({ name: 'episode_id', type: String })
  @ApiOperation({ summary: `Delete a chapter by id (permissions: ${UserPermission.MANAGE_MEDIA})` })
  @ApiNoContentResponse({ description: 'Chapters have been deleted' })
  @ApiUnauthorizedResponse({ description: 'You are not authorized', type: ErrorMessage })
  @ApiForbiddenResponse({ description: 'You do not have permission', type: ErrorMessage })
  @ApiBadRequestResponse({ description: 'Validation error', type: ErrorMessage })
  @ApiNotFoundResponse({ description: 'The episode (or the chapter) could not be found', type: ErrorMessage })
  deleteTVEpisodeChapters(
    @AuthUser() authUser: AuthUserDto,
    @Param('id', ParseBigIntPipe) id: bigint,
    @Param('episode_id', ParseBigIntPipe) episodeId: bigint,
    @RequestHeaders(HeadersDto) headers: HeadersDto,
    @Query() deleteMediaChaptersDto: DeleteMediaChaptersDto
  ) {
    return this.mediaChaptersService.deleteTVEpisodeChapters(id, episodeId, deleteMediaChaptersDto, headers, authUser);
  }
}
